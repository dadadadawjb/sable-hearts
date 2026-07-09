export const SUITS = ['spade', 'heart', 'diamond', 'club'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
export type Rank = (typeof RANKS)[number];

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  deckIndex: number;
}

const suitCodes: Record<Suit, string> = {
  spade: 'S',
  heart: 'H',
  diamond: 'D',
  club: 'C',
};

const suitLabels: Record<Suit, string> = {
  spade: '♠',
  heart: '♥',
  diamond: '♦',
  club: '♣',
};

const rankLabels: Record<Rank, string> = {
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
  10: '10',
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

const suitOrder: Record<Suit, number> = {
  spade: 0,
  heart: 1,
  club: 2,
  diamond: 3,
};

export function cardId(suit: Suit, rank: Rank, deckIndex: number): string {
  return `${suitCodes[suit]}-${rank}-${deckIndex}`;
}

export function createCard(suit: Suit, rank: Rank, deckIndex: number): Card {
  return {
    id: cardId(suit, rank, deckIndex),
    suit,
    rank,
    deckIndex,
  };
}

export function suitLabel(suit: Suit): string {
  return suitLabels[suit];
}

export function rankLabel(rank: Rank): string {
  return rankLabels[rank];
}

export function cardLabel(card: Card): string {
  return `${suitLabel(card.suit)}${rankLabel(card.rank)}`;
}

export function isRedSuit(suit: Suit): boolean {
  return suit === 'heart' || suit === 'diamond';
}

export function sortHand(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const suitDiff = suitOrder[a.suit] - suitOrder[b.suit];
    if (suitDiff !== 0) return suitDiff;
    if (a.rank !== b.rank) return b.rank - a.rank;
    return a.deckIndex - b.deckIndex;
  });
}
