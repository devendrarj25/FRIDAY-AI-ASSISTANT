declare module "jpeg-js" {
  export function decode(
    jpegData: Uint8Array,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean; maxResolutionInMP?: number },
  ): { width: number; height: number; data: Uint8Array };

  export function encode(
    image: { data: Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Uint8Array; width: number; height: number };
}

declare module "regenerator-runtime" {
  const runtime: object;
  export default runtime;
}
