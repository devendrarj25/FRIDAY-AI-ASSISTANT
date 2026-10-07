/** What the owner has said about himself. Local notes, with a forget path. */

export type OwnerCard = {
  goals: string[];
  habits: string[];
  people: string[];
  vocabulary: string[];
};

const EMPTY = (): OwnerCard => ({ goals: [], habits: [], people: [], vocabulary: [] });
let card: OwnerCard = EMPTY();

function push(list: string[], value: string): void {
  const text = value.trim().slice(0, 160);
  if (!text || list.includes(text)) return;
  list.push(text);
  if (list.length > 12) list.shift();
}

export function noteOwnerUtterance(text: string): OwnerCard {
  const value = String(text || "");
  if (/password|token|api[_-]?key/i.test(value)) return ownerSnapshot();
  const goal = value.match(/\b(?:mera goal|my goal is|i want to)\s+(.{3,80})/i);
  if (goal?.[1]) push(card.goals, goal[1]);
  const habit = value.match(/\b(?:roz|every morning|subah)\s+(.{3,80})/i);
  if (habit?.[1]) push(card.habits, habit[1]);
  const person = value.match(/\b(?:meri|my)\s+(wife|friend|bhai|behen)\s+(.{2,40})/i);
  if (person?.[2]) push(card.people, `${person[1]} ${person[2]}`.trim());
  const nick = value.match(/\bcall me\s+([A-Za-z]{2,20})/i);
  if (nick?.[1]) push(card.vocabulary, nick[1]);
  return ownerSnapshot();
}

export function ownerSnapshot(): OwnerCard {
  return {
    goals: [...card.goals],
    habits: [...card.habits],
    people: [...card.people],
    vocabulary: [...card.vocabulary],
  };
}

export function forgetOwner(
  part: "goals" | "habits" | "people" | "vocabulary" | "all" = "all",
): void {
  if (part === "all") card = EMPTY();
  else card[part] = [];
}
