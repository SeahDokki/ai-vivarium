/**
 * Avatar catalog: 5 characters, each recoloured with 3 slots (skin, top, bottom).
 * Agents pick by id and colour name; sprites map these to pixels on the spectator side.
 * Character looks are placeholders until the sprites exist.
 */

export const CHARACTERS = ["character_1", "character_2", "character_3", "character_4", "character_5"] as const;
export type CharacterId = (typeof CHARACTERS)[number];

/** Skin tones, light to dark. */
export const SKIN_TONES: Readonly<Record<string, string>> = {
  porcelain: "#fce4c8",
  light: "#f5c99a",
  sand: "#e0a86e",
  tan: "#c68642",
  brown: "#8d5524",
  deep: "#5a3a22",
};

/** Clothing palette, 8-bit style. */
export const CLOTHES_COLORS: Readonly<Record<string, string>> = {
  white: "#fcfcfc",
  grey: "#7c7c7c",
  black: "#202020",
  red: "#d82800",
  orange: "#fc7400",
  yellow: "#f8b800",
  green: "#00a800",
  teal: "#008888",
  blue: "#0058f8",
  navy: "#00287c",
  purple: "#6844fc",
  pink: "#f878f8",
};

export interface Avatar {
  readonly character: CharacterId;
  readonly skin: string;
  readonly top: string;
  readonly bottom: string;
}

export const DEFAULT_AVATAR: Avatar = { character: "character_1", skin: "light", top: "blue", bottom: "navy" };

export type AvatarCheck = { readonly ok: true; readonly value: Avatar } | { readonly ok: false; readonly detail: string };

/** Validate untrusted input. Missing fields fall back to the default avatar. */
export function parseAvatar(input: unknown): AvatarCheck {
  if (input === undefined || input === null) return { ok: true, value: DEFAULT_AVATAR };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, detail: "avatar must be an object" };
  const raw = input as Record<string, unknown>;
  const character = raw["character"] ?? DEFAULT_AVATAR.character;
  const skin = raw["skin"] ?? DEFAULT_AVATAR.skin;
  const top = raw["top"] ?? DEFAULT_AVATAR.top;
  const bottom = raw["bottom"] ?? DEFAULT_AVATAR.bottom;

  if (typeof character !== "string" || !(CHARACTERS as readonly string[]).includes(character)) {
    return { ok: false, detail: `character must be one of: ${CHARACTERS.join(", ")}` };
  }
  if (typeof skin !== "string" || !Object.hasOwn(SKIN_TONES, skin)) {
    return { ok: false, detail: `skin must be one of: ${Object.keys(SKIN_TONES).join(", ")}` };
  }
  for (const [slot, value] of [["top", top], ["bottom", bottom]] as const) {
    if (typeof value !== "string" || !Object.hasOwn(CLOTHES_COLORS, value)) {
      return { ok: false, detail: `${slot} must be one of: ${Object.keys(CLOTHES_COLORS).join(", ")}` };
    }
  }
  return { ok: true, value: { character: character as CharacterId, skin, top: top as string, bottom: bottom as string } };
}

/** The catalog as sent to agents so they can choose. */
export function avatarCatalog() {
  return {
    characters: [...CHARACTERS],
    skin: Object.keys(SKIN_TONES),
    top: Object.keys(CLOTHES_COLORS),
    bottom: Object.keys(CLOTHES_COLORS),
  };
}
