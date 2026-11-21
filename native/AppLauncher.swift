import Cocoa
class AppDelegate:NSObject,NSApplicationDelegate {
 var child:Process?
 func applicationDidFinishLaunching(_ notification:Notification){
  let app=Bundle.main.bundleURL,resources=app.appendingPathComponent("Contents/Resources"),runtime=resources.appendingPathComponent("app")
  let support=FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("LingXu")
  let records=support.appendingPathComponent("recordings"),logs=support.appendingPathComponent("logs")
  do{
   try FileManager.default.createDirectory(at:records,withIntermediateDirectories:true);try FileManager.default.createDirectory(at:logs,withIntermediateDirectories:true)
   let file=logs.appendingPathComponent("启动-\(Int(Date().timeIntervalSince1970)).log");FileManager.default.createFile(atPath:file.path,contents:nil)
   let output=try FileHandle(forWritingTo:file),process=Process();process.executableURL=resources.appendingPathComponent("node");process.currentDirectoryURL=runtime
   process.arguments=[runtime.appendingPathComponent("scripts/human-interview.mjs").path]+CommandLine.arguments.dropFirst()
   var env=ProcessInfo.processInfo.environment;env["HUMAN_RECORDINGS_DIR"]=records.path;env["PATH"]="/usr/bin:/bin:/usr/sbin:/sbin";process.environment=env;process.standardOutput=output;process.standardError=output;process.standardInput=FileHandle(forReadingAtPath:"/dev/null")
   process.terminationHandler={p in DispatchQueue.main.async{try? output.close();NSApplication.shared.terminate(nil)}}
   child=process;try process.run()
  }catch{try? error.localizedDescription.write(to:logs.appendingPathComponent("启动失败.txt"),atomically:true,encoding:.utf8);NSApplication.shared.terminate(nil)}
 }
 func applicationWillTerminate(_ notification:Notification){if let p=child,p.isRunning{p.terminate()}}
 func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{return false}
}
if CommandLine.arguments.count==4 && CommandLine.arguments[1]=="--make-alias" {
 let source=URL(fileURLWithPath:CommandLine.arguments[2]),target=URL(fileURLWithPath:CommandLine.arguments[3]);let data=try source.bookmarkData(options:.suitableForBookmarkFile,includingResourceValuesForKeys:nil,relativeTo:nil);try URL.writeBookmarkData(data,to:target);exit(0)
}
let app=NSApplication.shared,delegate=AppDelegate();app.delegate=delegate;app.setActivationPolicy(.accessory);app.run()
