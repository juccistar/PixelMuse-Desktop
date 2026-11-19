/** 文件头只作入口筛选，真实格式/像素上限仍由后台解码确认。 */
export function imageTypeFromHeader(bytes: Uint8Array): string | undefined {
  const starts = (values: number[]) => values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  if (ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP') return 'image/webp';
  if (starts([73,73,42,0]) || starts([77,77,0,42])) return 'image/tiff';
  if (ascii(4,8) === 'ftyp') {
    for (let index = 8; index + 4 <= bytes.length && index < 64; index += 4) if (index !== 12 && ['avif','avis'].includes(ascii(index,index+4))) return 'image/avif';
  }
  return undefined;
}
