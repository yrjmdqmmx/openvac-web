export type ModelingPoint3 = readonly [number, number, number];

export function pointDistanceMillimeters(
  first: ModelingPoint3,
  second: ModelingPoint3,
  millimetersPerWorldUnit: number
) {
  if (
    !Number.isFinite(millimetersPerWorldUnit) ||
    millimetersPerWorldUnit <= 0
  ) {
    throw new RangeError("测量比例必须是正有限数。");
  }
  const coordinates = [...first, ...second];
  if (!coordinates.every(Number.isFinite)) {
    throw new RangeError("测量点坐标必须是有限数。");
  }
  return (
    Math.hypot(
      second[0] - first[0],
      second[1] - first[1],
      second[2] - first[2]
    ) * millimetersPerWorldUnit
  );
}
