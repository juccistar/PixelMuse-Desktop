import { ChangeEventSchema, type ChangeEvent } from '@ecomgen/contracts';
import { check } from '../validation.js';
import type { RuntimeStore } from './state.js';
import type { EventPort } from './ports.js';
/** 事件只触发失效重查；事务回滚丢弃该层通知，订阅故障不改判业务。 */
export class InvalidationEvents implements EventPort {
 private frames:ChangeEvent[][]=[];
 constructor(private readonly store:RuntimeStore,private readonly listener:(event:ChangeEvent)=>void){}
 publish(event:ChangeEvent):void {
  check(ChangeEventSchema,event,true);
  if(this.frames.length){this.frames[this.frames.length-1]!.push(structuredClone(event));return;}
  // 不接受绕过 context.transaction 的事务内发送，避免发布尚未提交的状态。
  if(this.store.db.inTransaction)return;
  try{this.listener(event);}catch{/* 查询持久状态仍是唯一真相。 */}
 }
 transaction<T>(callback:()=>T):T {
  const pending:ChangeEvent[]=[];this.frames.push(pending);
  try{
   const result=this.store.transaction(callback);this.frames.pop();
   if(this.frames.length)this.frames[this.frames.length-1]!.push(...pending);
   else for(const event of pending)this.publish(event);
   return result;
  }catch(error){this.frames.pop();throw error;}
 }
}
