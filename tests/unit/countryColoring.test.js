import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorCountries, hasNoAdjacentClash, maxColorIndex } from '../../components/world-map/countryColoring.js';

test('no two adjacent nodes ever share a color, on a variety of graph shapes', () => {
  const graphs = {
    // A cycle of 5 (odd cycle needs 3 colors, not just 2)
    cycle5: [[1, 4], [0, 2], [1, 3], [2, 4], [3, 0]],
    // A "hub" node connected to 6 others that aren't connected to each other
    star: [[1, 2, 3, 4, 5, 6], [0], [0], [0], [0], [0], [0]],
    // A complete graph of 4 (every node touches every other — needs exactly 4 colors)
    complete4: [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]],
    // Two disconnected triangles
    disconnected: [[1, 2], [0, 2], [0, 1], [4, 5], [3, 5], [3, 4]],
  };

  for (const [name, graph] of Object.entries(graphs)) {
    const colors = colorCountries(graph);
    assert.ok(hasNoAdjacentClash(graph, colors), `${name}: found an adjacent color clash`);
  }
});

test('a complete graph of 4 mutually-adjacent nodes needs exactly 4 colors, no more', () => {
  const complete4 = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
  const colors = colorCountries(complete4);
  assert.equal(maxColorIndex(colors), 3); // colors 0..3, four distinct values required
});

test('processing high-degree nodes first keeps color count low on a hub-and-spoke graph', () => {
  // The hub (node 0) touches all 6 spokes; the spokes don't touch each other, so an
  // optimal coloring needs only 2 colors. Welsh-Powell colors the hub first (color 0),
  // then every spoke can reuse color 1 — naive index-order greedy gets the same result
  // here too, but this locks in the intended ordering behavior for a case where it
  // matters (the hub must not be colored after its spokes have already claimed low
  // color indices, which would force it to a higher one).
  const star = [[1, 2, 3, 4, 5, 6], [0], [0], [0], [0], [0], [0]];
  const colors = colorCountries(star);
  assert.equal(colors[0], 0);
  assert.ok(colors.slice(1).every((c) => c === 1));
});

test('hasNoAdjacentClash catches a real clash', () => {
  const graph = [[1], [0]];
  assert.equal(hasNoAdjacentClash(graph, [0, 0]), false);
  assert.equal(hasNoAdjacentClash(graph, [0, 1]), true);
});
