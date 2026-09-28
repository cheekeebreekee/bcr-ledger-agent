import { defangLinks, undoLinkDefang } from './linkText';

describe('defangLinks', () => {
  it.each([
    ['https://evil.example/x', 'https꞉//evil․example/x'],
    ['www.evil.example', 'www․evil․example'],
    ['a@evil.example', 'a＠evil․example'],
    ['Sp. z o.o.', 'Sp. z o․o.'],
    ['FV/2026/09/1', 'FV/2026/09/1'],
    ['1.234,50', '1.234,50'],
  ])('%p → %p', (value, expected) => {
    expect(defangLinks(value)).toBe(expected);
  });
});

describe('undoLinkDefang', () => {
  it.each([
    'https://evil.example/x',
    'a@evil.example',
    'Dostawca Testowy Sp. z o.o.',
    'FV/1/2026.KOR',
    'Allegro.pl S.A.',
  ])('gives back %p from its card form', (value) => {
    expect(undoLinkDefang(defangLinks(value))).toBe(value);
  });

  it('leaves ordinary text alone', () => {
    expect(undoLinkDefang('faktury od Kowalskiego z marca')).toBe('faktury od Kowalskiego z marca');
  });
});
