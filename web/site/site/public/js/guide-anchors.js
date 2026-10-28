// The guide was one page; each chapter is its own page now. A link to an old anchor on it
// (/docs/guide#privacy) lands on /docs/guide, whose JSON block (#guide-anchors) maps every old
// anchor to its chapter and section: this sends the reader there. A file, as the CSP blocks
// inline scripts.
(function () {
  var block = document.getElementById('guide-anchors');
  if (!block || location.hash.length < 2) return;
  var id;
  var map;
  try {
    id = decodeURIComponent(location.hash.slice(1));
    map = JSON.parse(block.textContent);
  } catch (e) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(map, id)) location.replace(map[id]);
})();
