/**
 * Who is using the tool. Not authentication — the passphrase is the gate, this
 * is the Netflix "who's watching" step so each person keeps their own history.
 */

export type ProfileId = "cory" | "grace" | "thomas";

export type Profile = {
  id: ProfileId;
  name: string;
  /** The single letter shown on the avatar. */
  initial: string;
};

export const PROFILES: Profile[] = [
  { id: "cory", name: "Cory", initial: "C" },
  { id: "grace", name: "Grace", initial: "G" },
  { id: "thomas", name: "Thomas", initial: "T" },
];

export const PROFILE_COOKIE = "zscore_profile";

export function isProfileId(v: unknown): v is ProfileId {
  return typeof v === "string" && PROFILES.some((p) => p.id === v);
}

export function findProfile(id: string | undefined): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
