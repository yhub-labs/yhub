// Small, practical pinyin + fuzzy search helpers.

// GB2312 common-hanzi first-letter ranges (codepoint range → pinyin initial)
const PINYIN_RANGES: [number, number, string][] = [
  [0x4e00, 0x4e9f, 'y'],
  [0xb0a1, 0xb0c4, 'a'],
  [0xb0c5, 0xb2c0, 'b'],
  [0xb2c1, 0xb4ed, 'c'],
  [0xb4ee, 0xb6e9, 'd'],
  [0xb6ea, 0xb7a1, 'e'],
  [0xb7a2, 0xb8c0, 'f'],
  [0xb8c1, 0xb9fd, 'g'],
  [0xb9fe, 0xbbf6, 'h'],
  [0xbbf7, 0xbbf7, 'j'],
  [0xbbf8, 0xbfa5, 'j'],
  [0xbfa6, 0xc0ab, 'k'],
  [0xc0ac, 0xc2e7, 'l'],
  [0xc2e8, 0xc4c2, 'm'],
  [0xc4c3, 0xc5b5, 'n'],
  [0xc5b6, 0xc5bd, 'o'],
  [0xc5be, 0xc6d9, 'p'],
  [0xc6da, 0xc8ba, 'q'],
  [0xc8bb, 0xc8f5, 'r'],
  [0xc8f6, 0xcbfa, 's'],
  [0xcbfb, 0xcdd9, 't'],
  [0xcdda, 0xcef3, 'w'],
  [0xcef4, 0xd1b8, 'x'],
  [0xd1b9, 0xd4d0, 'y'],
  [0xd4d1, 0xd7f9, 'z'],
]

// Hand-written pinyin initials for high-frequency characters (supplements the ranges above)
const COMMON_CHAR_PINYIN: Record<string, string> = {
  微: 'w',
  信: 'x',
  系: 'x',
  统: 't',
  设: 's',
  置: 'z',
  终: 'z',
  端: 'd',
  汉: 'h',
  典: 'd',
  私: 's',
  密: 'm',
  编: 'b',
  辑: 'j',
  器: 'q',
  内: 'n',
  存: 'c',
  盘: 'p',
  随: 's',
  手: 's',
  记: 'j',
  活: 'h',
  动: 'd',
  监: 'j',
  视: 's',
  备: 'b',
  忘: 'w',
  录: 'l',
  日: 'r',
  历: 'l',
  计: 'j',
  算: 's',
  音: 'y',
  乐: 'y',
  访: 'f',
  达: 'd',
  邮: 'y',
  件: 'j',
  腾: 't',
  讯: 'x',
  会: 'h',
  议: 'y',
  飞: 'f',
  书: 's',
  钉: 'd',
  百: 'b',
  度: 'd',
  网: 'w',
  络: 'l',
  相: 'x',
  机: 'j',
  照: 'z',
  片: 'p',
  地: 'd',
  图: 't',
  字: 'z',
  体: 't',
  册: 'c',
  快: 'k',
  捷: 'j',
  指: 'z',
  令: 'l',
}

export function getPinyinInitials(str: string): string {
  let initials = ''
  for (const char of str) {
    if (COMMON_CHAR_PINYIN[char]) {
      initials += COMMON_CHAR_PINYIN[char]
      continue
    }
    const code = char.charCodeAt(0)
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57)) {
      initials += char.toLowerCase()
    } else {
      let found = false
      for (const [start, end, letter] of PINYIN_RANGES) {
        if (code >= start && code <= end) {
          initials += letter
          found = true
          break
        }
      }
      if (!found && char.trim()) {
        initials += char.toLowerCase()
      }
    }
  }
  return initials
}

export function fuzzyMatch(text: string, query: string, extraKeywords = ''): boolean {
  const cleanQ = query.trim().toLowerCase()
  if (!cleanQ) return true

  const cleanText = text.toLowerCase()
  if (cleanText.includes(cleanQ)) return true

  if (extraKeywords && extraKeywords.toLowerCase().includes(cleanQ)) return true

  // pinyin initials
  const initials = getPinyinInitials(text)
  if (initials.includes(cleanQ)) return true

  // subsequence match, e.g. "vsc" matches "visual studio code"
  let qIdx = 0
  for (let i = 0; i < cleanText.length && qIdx < cleanQ.length; i++) {
    if (cleanText[i] === cleanQ[qIdx]) {
      qIdx++
    }
  }
  if (qIdx === cleanQ.length) return true

  return false
}
