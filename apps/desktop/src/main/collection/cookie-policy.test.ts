import { describe, expect, it } from 'vitest';
import { isSchemefulSameSite } from './cookie-policy.js';

describe('Chromium schemeful same-site cookie scope', () => {
  it.each([
    ['https://shop.example.com/item', 'https://cdn.example.com/img', true],
    ['https://shop.example.co.uk/item', 'https://cdn.example.co.uk/img', true],
    ['https://shop.example.co.uk/item', 'https://other.co.uk/img', false],
    ['https://shop.example.co.uk./item', 'https://cdn.example.co.uk/img', false],
    ['https://shop.example.co.uk/item', 'https://cdn.example.co.uk./img', false],
    ['https://shop.example.co.uk./item', 'https://cdn.example.co.uk./img', true],
    ['https://shop.example.com./item', 'https://shop.example.com/img', false],
    ['https://first.github.io/item', 'https://second.github.io/img', false],
    ['https://shop.first.github.io/item', 'https://cdn.first.github.io/img', true],
    ['https://shop.example.com/item', 'http://cdn.example.com/img', false],
    ['http://127.0.0.1:9000/item', 'http://127.0.0.1:8000/img', true],
    ['http://127.0.0.1/item', 'http://127.0.0.2/img', false],
    ['https://shop.食狮.com.cn/item', 'https://cdn.食狮.com.cn/img', true],
  ])('%s → %s: %s', (page, image, sameSite) => {
    expect(isSchemefulSameSite(new URL(page), new URL(image))).toBe(sameSite);
  });
});
