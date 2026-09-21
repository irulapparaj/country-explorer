// Greedy graph coloring over topojson.neighbors() adjacency lists, so that no two
// countries sharing a border are ever filled with the same color. Pure and
// dependency-free: it takes plain adjacency-index arrays, not D3/topojson objects, so
// it works the same in a browser or in a Node unit test.
//
// Nodes are colored in descending-degree order (Welsh-Powell), not array order — a
// country with many neighbors (Russia borders 14) gets first pick of the palette,
// which avoids far more clashes than naive index-order greedy would. Colors are not
// capped to the palette size while assigning (each pick is guaranteed clash-free
// against already-colored neighbors); wrapping into a fixed-size CSS palette happens
// as a separate, later step in the caller once real adjacency data confirms it's safe
// (see the "colorCountries" call site for how many colors the real 241-country
// world-atlas topology actually needs).

/**
 * @param {number[][]} neighborLists neighborLists[i] = indices adjacent to node i
 * @returns {number[]} colorIndex[i], guaranteed to differ from every listed neighbor's
 */
export function colorCountries(neighborLists) {
  const n = neighborLists.length;
  const colors = new Array(n).fill(-1);
  const order = [...Array(n).keys()].sort((a, b) => neighborLists[b].length - neighborLists[a].length);

  for (const i of order) {
    const usedByNeighbors = new Set(neighborLists[i].map((j) => colors[j]).filter((c) => c !== -1));
    let color = 0;
    while (usedByNeighbors.has(color)) color++;
    colors[i] = color;
  }
  return colors;
}

/** True if every adjacent pair in neighborLists has a different color — used to
 * validate a coloring, especially after wrapping raw color indices into a fixed
 * palette size. */
export function hasNoAdjacentClash(neighborLists, colors) {
  return neighborLists.every((neighbors, i) => neighbors.every((j) => colors[i] !== colors[j]));
}

export function maxColorIndex(colors) {
  return colors.reduce((max, c) => Math.max(max, c), -1);
}
