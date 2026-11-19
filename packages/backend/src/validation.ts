import type { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ByteImportSchema, MAX_IMAGE_TRANSPORT_BYTES, type AppError, type ByteImport } from '@ecomgen/contracts';
/** 仅携带可跨 IPC 公开的错误，不携带内部路径、原始响应或密钥。 */
export class BackendError extends Error implements AppError {
 constructor(public readonly code:string,message:string){super(message);this.name='BackendError';}
 toJSON():AppError{return {code:this.code,message:this.message};}
}
/** 校验错误不附输入或具体 schema 路径，避免泄漏凭据。 */
export function check(schema:TSchema,value:unknown,output=false):void {
 let valid=false;try{valid=Value.Check(schema,value);}catch{/* 非法 schema 同样安全收敛。 */}
 if(!valid)throw new BackendError(output?'INTERNAL_ERROR':'INVALID_INPUT',output?'返回数据校验失败。':'命令参数无效。');
}
export function safeError(error:unknown):BackendError {return error instanceof BackendError?error:new BackendError('INTERNAL_ERROR','操作失败，请重试。');}
/** 除 schema 投影外，检查自由 JSON 字段中的敏感字段和文件系统路径。 */
export function assertPublicOutput(value:unknown):void {
 const visit=(entry:unknown,key='')=>{
  if(Array.isArray(entry)){for(const child of entry)visit(child,key);return;}
  if(entry&&typeof entry==='object'){
   for(const [name,child]of Object.entries(entry)){
    if(/^(?:apiKey|encryptedKey|encryptedApiKey|masterKey|storagePath|psdStoragePath|editMaskPath|protectMaskPath|referenceFacePath|privateSnapshot|providerSnapshot|generationSnapshot|bodyBase64|encryptedReceipt|sealedCredential|authorization)$/i.test(name))throw new BackendError('PRIVATE_OUTPUT','返回数据包含内部字段。');
    visit(child,name);
   }return;
  }
  if(typeof entry==='string'&&(/^[a-z]:[\\/]/i.test(entry)||/^\\\\/.test(entry)||/^\/(?:Users|home|tmp|var|etc)\//.test(entry)))throw new BackendError('PRIVATE_OUTPUT','返回数据包含内部路径。');
 };
 visit(value);
}
/** 只核验规范 Base64、传输容量与签名；调用方仍须用 Sharp 真正解码并校验像素。 */
export function decodeByteImport(input:ByteImport):Buffer {
 check(ByteImportSchema,input);
 if(input.base64.length%4!==0)throw new BackendError('INVALID_IMAGE','图片编码无效。');
 const bytes=Buffer.from(input.base64,'base64');
 if(bytes.length<1||bytes.length>MAX_IMAGE_TRANSPORT_BYTES||bytes.toString('base64')!==input.base64)throw new BackendError('INVALID_IMAGE','图片内容或大小无效。');
 const png=bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 const webp=bytes.length>=12&&bytes.subarray(0,4).toString('latin1')==='RIFF'&&bytes.subarray(8,12).toString('latin1')==='WEBP';
 const matches=input.mimeType==='image/png'?png:input.mimeType==='image/jpeg'?jpeg:input.mimeType==='image/webp'?webp:input.mimeType==='image/avif'?hasAvifBrand(bytes):hasTiffHeader(bytes);
 if(!matches)throw new BackendError('INVALID_IMAGE','图片类型与内容不符。');
 return bytes;
}
/** AVIF 可用通用主品牌配兼容 avif/avis 品牌；不能将所有 HEIF/mif1 容器当成 AVIF。 */
function hasAvifBrand(bytes:Buffer):boolean {
 if(bytes.length<16||bytes.toString('latin1',4,8)!=='ftyp')return false;
 let size=bytes.readUInt32BE(0),header=8;
 if(size===1){
  if(bytes.length<24)return false;
  const extended=bytes.readBigUInt64BE(8);
  if(extended>BigInt(bytes.length))return false;
  size=Number(extended);header=16;
 }else if(size===0)size=bytes.length;
 if(size<header+8||size>bytes.length||(size-header)%4!==0)return false;
 const avif=(offset:number)=>{const brand=bytes.toString('latin1',offset,offset+4);return brand==='avif'||brand==='avis';};
 if(avif(header))return true;
 // 跳过 major_brand 后的 minor_version，按完整四字节 compatible_brand 检查。
 for(let offset=header+8;offset<size;offset+=4)if(avif(offset))return true;
 return false;
}
/** TIFF 的两种端序与 BigTIFF 头；IFD/像素完整性仍由图像解码器负责。 */
function hasTiffHeader(bytes:Buffer):boolean {
 if(bytes.length<8)return false;
 const little=bytes[0]===0x49&&bytes[1]===0x49,big=bytes[0]===0x4d&&bytes[1]===0x4d;
 if(!little&&!big)return false;
 const read=(offset:number)=>little?bytes.readUInt16LE(offset):bytes.readUInt16BE(offset);
 return read(2)===42||(read(2)===43&&bytes.length>=16&&read(4)===8&&read(6)===0);
}
