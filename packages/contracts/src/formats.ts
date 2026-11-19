import { FormatRegistry } from '@sinclair/typebox';
/** 每个 Electron/Backend 进程安装相同格式校验，避免 TypeBox 未注册格式导致误拒绝。 */
export function registerContractFormats():void {
 FormatRegistry.Set('uuid',value=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
 FormatRegistry.Set('date-time',value=>/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value)));
 FormatRegistry.Set('uri',value=>{try{return !!new URL(value).protocol;}catch{return false;}});
}
registerContractFormats();
