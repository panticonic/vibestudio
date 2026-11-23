import {expect,it} from "vitest";
import {WorkerdInspectorProtocol} from "./workerdInspectorProtocol.js";
it("normalizes only exact outstanding workerd empty acknowledgements",()=>{
 const protocol=new WorkerdInspectorProtocol();
 expect(protocol.observeCommand('{"id":1,"method":"Profiler.enable"}')).toBe(true);
 expect(protocol.receive('{"id":1,"method":"Profiler.start","params":{}}')).toContain('"method"');
 expect(protocol.receive('{"id":2,"method":"Profiler.enable","params":{}}')).toContain('"method"');
 expect(protocol.receive('{"id":1,"method":"Profiler.enable","params":{"forged":true}}')).toContain('"method"');
 expect(protocol.receive('{"id":1,"method":"Profiler.enable","params":{},"extra":true}')).toContain('"method"');
 expect(JSON.parse(protocol.receive('{"id":1,"method":"Profiler.enable","params":{}}'))).toEqual({id:1,result:{}});
 expect(protocol.receive('{"id":1,"method":"Profiler.enable","params":{}}')).toContain('"method"');
 expect(protocol.observeCommand('{"id":3,"method":"Profiler.stop"}')).toBe(true);
 const stopped='{"id":3,"result":{"profile":{"samples":[1]}}}';
 expect(protocol.receive(stopped)).toBe(stopped);
 expect(protocol.receive('{"id":3,"method":"Profiler.stop","params":{}}')).toContain('"method"');
});
it("preserves standard native errors and bounds unfinished acknowledgements",()=>{
 const protocol=new WorkerdInspectorProtocol();
 protocol.observeCommand('{"id":1,"method":"Profiler.enable"}');
 const failure='{"id":1,"error":{"message":"native error"}}';expect(protocol.receive(failure)).toBe(failure);
 expect(protocol.receive('{"id":1,"method":"Profiler.enable","params":{}}')).toContain('"method"');
 for(let id=0;id<256;id++)expect(protocol.observeCommand(JSON.stringify({id,method:"Profiler.start"}))).toBe(true);
 expect(protocol.observeCommand('{"id":256,"method":"Profiler.start"}')).toBe(false);
 protocol.clear();expect(protocol.observeCommand('{"id":256,"method":"Profiler.start"}')).toBe(true);
});
