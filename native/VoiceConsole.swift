import Foundation
import AVFoundation

let logLock=NSLock()
func event(_ data:[String:Any]) {
    logLock.lock();defer{logLock.unlock()}
    var out=data;out["native_time_s"]=ProcessInfo.processInfo.systemUptime
    if let bytes=try? JSONSerialization.data(withJSONObject:out),var text=String(data:bytes,encoding:.utf8){text += "\n";FileHandle.standardError.write(Data(text.utf8))}
}
if CommandLine.arguments.contains("--status") {
    event(["type":"status","microphone_authorization":AVCaptureDevice.authorizationStatus(for:.audio).rawValue]);exit(0)
}
let playerFormat=AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:16000,channels:1,interleaved:false)!
func floatBuffer(_ pcm:Data)->AVAudioPCMBuffer {
    let b=AVAudioPCMBuffer(pcmFormat:playerFormat,frameCapacity:AVAudioFrameCount(pcm.count/2))!;b.frameLength=b.frameCapacity
    pcm.withUnsafeBytes{(p:UnsafeRawBufferPointer)in for i in 0..<Int(b.frameLength){let v=Int16(bitPattern:UInt16(p[i*2])|UInt16(p[i*2+1])<<8);b.floatChannelData![0][i]=Float(v)/32768}}
    return b
}
if CommandLine.arguments.contains("--self-test") {
    let b=floatBuffer(Data([0,0,0,64,0,192]));guard b.frameLength==3 && b.floatChannelData![0][1]==0.5 && b.floatChannelData![0][2] == -0.5 else{exit(2)}
    event(["type":"self_test","passed":true]);exit(0)
}
guard CommandLine.arguments.count>=2 else{event(["type":"error","message":"缺少录音文件夹"]);exit(2)}
let folder=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let status=AVCaptureDevice.authorizationStatus(for:.audio)
if status == .notDetermined {
    event(["type":"permission_required"])
    let sem=DispatchSemaphore(value:0);var allowed=false
    AVCaptureDevice.requestAccess(for:.audio){value in allowed=value;sem.signal()}
    sem.wait();if !allowed{event(["type":"error","message":"尚未允许系统麦克风访问"]);exit(3)}
} else if status != .authorized {event(["type":"error","message":"系统麦克风权限未开启"]);exit(3)}

let engine=AVAudioEngine(),player=AVAudioPlayerNode()
let input=engine.inputNode,inputFormat=input.outputFormat(forBus:0)
guard inputFormat.sampleRate>0 && inputFormat.channelCount>0 else{event(["type":"error","message":"没有可用麦克风"]);exit(4)}
engine.attach(player);engine.connect(player,to:engine.mainMixerNode,format:playerFormat)
let outputFormat=engine.mainMixerNode.outputFormat(forBus:0)
let captureFormat=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true)!
let converter=AVAudioConverter(from:inputFormat,to:captureFormat)!
var micFile:AVAudioFile!,speakerFile:AVAudioFile!
do {
    micFile=try AVAudioFile(forWriting:folder.appendingPathComponent("microphone.caf"),settings:inputFormat.settings)
    speakerFile=try AVAudioFile(forWriting:folder.appendingPathComponent("interviewer-playback.caf"),settings:outputFormat.settings)
}catch{event(["type":"error","message":"无法创建系统音频录音文件"]);exit(5)}
var firstMic=true,firstOutput=true
input.installTap(onBus:0,bufferSize:960,format:inputFormat){buffer,time in
    if firstMic{firstMic=false;event(["type":"capture_origin","track":"microphone","host_s":AVAudioTime.seconds(forHostTime:time.hostTime),"rate":inputFormat.sampleRate])}
    do{try micFile.write(from:buffer)}catch{event(["type":"error","message":"麦克风录音写入失败"])}
    let capacity=AVAudioFrameCount(ceil(Double(buffer.frameLength)*16000/inputFormat.sampleRate)+64)
    let out=AVAudioPCMBuffer(pcmFormat:captureFormat,frameCapacity:capacity)!
    var used=false,error:NSError?
    converter.convert(to:out,error:&error){_,status in if used{status.pointee = .noDataNow;return nil};used=true;status.pointee = .haveData;return buffer}
    if error != nil{event(["type":"error","message":"麦克风PCM转换失败"]);return}
    if out.frameLength>0{let data=Data(bytes:out.int16ChannelData![0],count:Int(out.frameLength)*2);FileHandle.standardOutput.write(data)}
}
engine.mainMixerNode.installTap(onBus:0,bufferSize:960,format:outputFormat){buffer,time in
    if firstOutput{firstOutput=false;event(["type":"capture_origin","track":"interviewer","host_s":AVAudioTime.seconds(forHostTime:time.hostTime),"rate":outputFormat.sampleRate])}
    do{try speakerFile.write(from:buffer)}catch{event(["type":"error","message":"采访员录音写入失败"])}
}
do{try engine.start();player.play()}catch{event(["type":"error","message":"系统音频引擎启动失败"]);exit(6)}
event(["type":"ready","input_rate":inputFormat.sampleRate,"output_rate":outputFormat.sampleRate])
let commandQueue=DispatchQueue(label:"interview.commands")
DispatchQueue.global(qos:.userInitiated).async {
    while let line=readLine(){
        guard let data=line.data(using:.utf8),let item=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let action=item["action"] as? String else{continue}
        if action == "stop"{DispatchQueue.main.async{player.stop();engine.stop();input.removeTap(onBus:0);engine.mainMixerNode.removeTap(onBus:0);micFile=nil;speakerFile=nil;event(["type":"stopped"]);exit(0)};return}
        if action == "chunk",let encoded=item["pcm"] as? String,let pcm=Data(base64Encoded:encoded),pcm.count%2==0 {
            let b=floatBuffer(pcm),ids=["run_id":item["run_id"] as? String ?? "","turn_id":item["turn_id"] as? String ?? "","chunk_id":item["chunk_id"] as? String ?? ""]
            commandQueue.async { player.scheduleBuffer(b,completionCallbackType:.dataPlayedBack){_ in var done:[String:Any]=ids;done["type"]="chunk_played";event(done)} }
        }
    }
    DispatchQueue.main.async{engine.stop();exit(0)}
}
RunLoop.main.run()
