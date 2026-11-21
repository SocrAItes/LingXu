"""WASAPI audio bridge. stdout is PCM16; stderr is JSONL; stdin is JSONL.

Only the writer thread touches disk/stdout. The audio callback copies samples and
queues records; playback acknowledgments use PortAudio's estimated DAC clock.
"""
import base64
from collections import deque
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import wave

RATE = 16000
BLOCK = 320
event_lock = threading.Lock()


def emit(kind, **data):
    with event_lock:
        sys.stderr.write(json.dumps({"type": kind, **data}, ensure_ascii=False) + "\n")
        sys.stderr.flush()


class Playback:
    def __init__(self):
        self.chunks = deque()
        self.lock = threading.Lock()

    def add(self, command):
        pcm = base64.b64decode(command["pcm"], validate=True)
        if len(pcm) % 2:
            raise ValueError("PCM16 requires complete samples")
        with self.lock:
            self.chunks.append([pcm, 0, {k: command.get(k) for k in ("run_id", "turn_id", "chunk_id")}])

    def fill(self, size):
        output = bytearray(size)
        completed = []
        offset = 0
        with self.lock:
            while self.chunks and offset < size:
                pcm, cursor, meta = self.chunks[0]
                count = min(size - offset, len(pcm) - cursor)
                output[offset:offset + count] = pcm[cursor:cursor + count]
                offset += count
                cursor += count
                if cursor == len(pcm):
                    completed.append((offset // 2, meta))
                    self.chunks.popleft()
                else:
                    self.chunks[0][1] = cursor
        return bytes(output), completed


def self_test():
    player = Playback()
    player.add({"pcm": base64.b64encode(b"\x01\x00" * 3).decode(), "chunk_id": "a"})
    first, done = player.fill(4)
    assert first == b"\x01\x00" * 2 and done == []
    last, done = player.fill(4)
    assert last == b"\x01\x00\x00\x00" and done[0][0] == 1
    assert done[0][1]["chunk_id"] == "a"
    emit("self_test", ok=True, rate=RATE, tested="PCM queue and chunk boundary; no audio device opened")


def main():
    if "--self-test" in sys.argv:
        self_test()
        return
    import sounddevice as sd
    if "--status" in sys.argv:
        try:
            devices = sd.query_devices()
            emit("status", devices=len(devices), available=bool(devices), backend="PortAudio/WASAPI")
        except Exception as error:
            emit("status", available=False, message=str(error))
        return
    if len(sys.argv) != 2:
        raise ValueError("Expected a recording directory")
    import msvcrt
    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    folder = Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    playback = Playback()
    stopped = threading.Event()
    packets = queue.Queue(maxsize=500)
    completions = queue.PriorityQueue()
    sequence = 0
    first = True
    failure = []

    def writer():
        with wave.open(str(folder / "microphone.wav"), "wb") as mic, wave.open(str(folder / "interviewer.wav"), "wb") as output:
            for track in (mic, output):
                track.setnchannels(1)
                track.setsampwidth(2)
                track.setframerate(RATE)
            while True:
                packet = packets.get()
                if packet is None:
                    break
                captured, played, origins, status = packet
                if origins:
                    for name, timestamp in origins.items():
                        emit("capture_origin", track=name, host_s=timestamp, rate=RATE)
                if status:
                    emit("audio_status", message=status)
                mic.writeframesraw(captured)
                output.writeframesraw(played)
                sys.stdout.buffer.write(captured)
                sys.stdout.buffer.flush()

    def guard_writer():
        try:
            writer()
        except Exception as error:
            failure.append(error)
            stopped.set()

    def callback(indata, outdata, frames, clock, status):
        nonlocal first, sequence
        played, done = playback.fill(frames * 2)
        outdata[:] = played
        origins = None
        if first:
            first = False
            origins = {"microphone": clock.inputBufferAdcTime, "interviewer": clock.outputBufferDacTime}
        # Convert the device clock into the local monotonic clock for waiting.
        delta = time.monotonic() - clock.currentTime
        for sample, meta in done:
            sequence += 1
            completions.put((clock.outputBufferDacTime + sample / RATE + delta, sequence, meta))
        try:
            packets.put_nowait((bytes(indata), played, origins, str(status) if status else None))
        except queue.Full:
            failure.append(RuntimeError("Audio writer cannot keep up; stopping to avoid silently losing recording frames"))
            stopped.set()
            raise sd.CallbackAbort

    def commands():
        try:
            for raw in sys.stdin.buffer:
                command = json.loads(raw)
                if command.get("action") == "stop":
                    break
                if command.get("action") == "chunk":
                    playback.add(command)
        except Exception as error:
            failure.append(error)
        finally:
            stopped.set()

    hosts = sd.query_hostapis()
    wasapi = next((h for h in hosts if "WASAPI" in h["name"]), None)
    if not wasapi or min(wasapi["default_input_device"], wasapi["default_output_device"]) < 0:
        raise RuntimeError("请设置 Windows 默认麦克风和扬声器，并允许桌面应用使用麦克风。")
    settings = sd.WasapiSettings(exclusive=False, auto_convert=True)
    worker = threading.Thread(target=guard_writer, daemon=True)
    worker.start()
    try:
        with sd.RawStream(samplerate=RATE, blocksize=BLOCK, channels=(1, 1), dtype="int16", callback=callback,
                          device=(wasapi["default_input_device"], wasapi["default_output_device"]),
                          extra_settings=(settings, settings)) as stream:
            emit("ready", input_rate=RATE, output_rate=RATE, backend="WASAPI shared", latency=stream.latency)
            threading.Thread(target=commands, daemon=True).start()
            waiting = None
            while not stopped.wait(0.005):
                if not stream.active:
                    raise RuntimeError("Audio stream stopped unexpectedly")
                while True:
                    if waiting is None:
                        try:
                            waiting = completions.get_nowait()
                        except queue.Empty:
                            break
                    due, _, meta = waiting
                    if time.monotonic() < due:
                        break
                    emit("chunk_played", **meta, native_time_s=time.monotonic(), timing_basis="PortAudio estimated output DAC time")
                    waiting = None
    finally:
        stopped.set()
        if worker.is_alive():
            packets.put(None, timeout=3)
        worker.join(timeout=4)
    if failure:
        raise failure[0]


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("error", message=str(error))
        sys.exit(1)
