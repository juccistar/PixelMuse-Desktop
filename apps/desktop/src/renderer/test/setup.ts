import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
if (!window.matchMedia) window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
class Observer { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver ??= Observer as unknown as typeof ResizeObserver;
window.IntersectionObserver ??= Observer as unknown as typeof IntersectionObserver;
const computedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((element: Element) => computedStyle(element)) as typeof window.getComputedStyle;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); });
