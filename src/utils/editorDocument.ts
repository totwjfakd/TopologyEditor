import type { MapRaster, TopologyDocument } from "../types";
import { fileBaseName } from "./mapFiles";

export function mapMatchesDocument(document: TopologyDocument, raster: MapRaster | null): boolean {
  return Boolean(raster && fileBaseName(document.map.image) === fileBaseName(raster.name));
}
