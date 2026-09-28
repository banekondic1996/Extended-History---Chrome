// Always fits the whole card (arrows + card + dots) within the current viewport —
// scales the "#stage" wrapper down when content would overflow the window height
// (or width), and back up again when there's room, instead of ever scrolling.
(function () {
  var stage = document.getElementById('stage');
  if (!stage) return;

  function fitStage() {
    stage.style.transform = 'scale(1)'; // reset first so we measure the natural, unscaled size
    var rect = stage.getBoundingClientRect();
    var naturalW = rect.width, naturalH = rect.height;
    if (!naturalW || !naturalH) return;
    var margin = 16; // small breathing room from the window edge
    var availW = window.innerWidth  - margin * 2;
    var availH = window.innerHeight - margin * 2;
    var scale = Math.min(availW / naturalW, availH / naturalH);
    if (!isFinite(scale) || scale <= 0) scale = 1;
    stage.style.transform = 'scale(' + scale + ')';
  }

  window.addEventListener('resize', fitStage);
  window.addEventListener('load', fitStage);
  fitStage();
})();

(function () {
  var track   = document.getElementById('track');
  var cards   = 6;
  var dotsEl  = document.getElementById('dots');
  var prevBtn = document.getElementById('prevBtn');
  var nextBtn = document.getElementById('nextBtn');
  var i = 0;

  for (let idx = 0; idx < 6; idx++) {
    var d = document.createElement('button');
    d.className = 'dot' + (idx === 0 ? ' active' : '');
    d.setAttribute('aria-label', 'Go to tip ' + (idx + 1) + ' of ' + cards.length);
    d.addEventListener('click', function () { go(idx); });
    dotsEl.appendChild(d);
  }
  var dots = Array.prototype.slice.call(dotsEl.children);

  function go(idx) {
    i = (idx + 6) % 6; // wraps around at either end
    track.style.transform = 'translateX(' + (-i * 100) + '%)';
    dots.forEach(function (d, n) { d.classList.toggle('active', n === i); });
  }

  prevBtn.addEventListener('click', function () { go(i - 1); });
  nextBtn.addEventListener('click', function () { go(i + 1); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft')  go(i - 1);
    if (e.key === 'ArrowRight') go(i + 1);
  });

  // Basic swipe support (trackpad/touch)
  var touchStartX = null;
  var viewport = document.querySelector('.viewport');
  viewport.addEventListener('touchstart', function (e) { touchStartX = e.touches[0].clientX; }, { passive: true });
  viewport.addEventListener('touchend', function (e) {
    if (touchStartX === null) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) go(i + (dx < 0 ? 1 : -1));
    touchStartX = null;
  }, { passive: true });
})();