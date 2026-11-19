import { createScopedCollectionService, type CollectionServiceOptions, type CollectionService } from './service.js';
import { publicTransportPolicy, type ImageTransportPolicy } from './transport.js';

/** 仅 Electron fixture 显式导入；正式入口不引用此工厂，也无环境变量开关。 */
export function createFixtureCollectionService(options: CollectionServiceOptions, fixtureOrigin: string): CollectionService {
  const fixture = new URL(fixtureOrigin);
  if (fixture.protocol !== 'http:' || fixture.hostname !== '127.0.0.1' || fixture.pathname !== '/' || fixture.search || fixture.hash || !fixture.port || fixture.username || fixture.password) throw new Error('Expected one exact loopback fixture origin');
  const policy: ImageTransportPolicy = {
    resolve: publicTransportPolicy.resolve,
    allow: (address, url) => url.origin === fixture.origin ? address === '127.0.0.1' : publicTransportPolicy.allow(address, url),
    allowPort: url => url.origin === fixture.origin || publicTransportPolicy.allowPort(url),
  };
  return createScopedCollectionService(options, policy);
}
