// Types for avatar.js, an ES module.
export declare const ARC_START: number;
export declare const ARC: number;
export interface AvatarSpec {
  readonly from: number;
  readonly stops: number[][];
}
export declare function avatarSpec(seed: unknown): AvatarSpec;
export declare function avatarBackground(seed: unknown): string;
export declare function avatarHtml(seed: unknown, extraClass?: string): string;
export declare function identitySeed(primaryName: string | null | undefined, address: string | null | undefined): string;
