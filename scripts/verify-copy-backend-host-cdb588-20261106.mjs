import { randomBytes } from 'node:crypto';
import { createBackend } from '../packages/backend/src/index.ts';
const backend=await createBackend({dataDir:process.argv[2],masterKey:randomBytes(32).toString('base64'),version:'isolated-real-cdb588'});
process.on('message',async message=>{
 try {
  if(message.operation==='__close') {await backend.close();process.send({id:message.id,value:true},()=>process.disconnect());return;}
  const value=await backend.invoke(message.operation,message.input); process.send({id:message.id,value});
 } catch(error) {process.send({id:message.id,error:{code:error.code,message:error.message}});}
});
process.send({ready:true});
