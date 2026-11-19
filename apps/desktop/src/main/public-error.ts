/** 仅显式构造的业务错误可返回页面，系统异常不包含在公开响应中。 */
export class PublicError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PublicError';
  }
}
