(() => {
  const canvas = document.getElementById("confetti-canvas");
  if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const context = canvas.getContext("2d");
  const colors = ["#007f6d", "#0369a1", "#047857", "#f59e0b", "#e11d48"];
  const pieces = [];
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let animationFrame;

  function resize() {
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width * pixelRatio;
    canvas.height = height * pixelRatio;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }

  function makePiece(startAboveViewport = false) {
    return {
      x: Math.random() * width,
      y: startAboveViewport ? -Math.random() * height : Math.random() * height,
      width: 5 + Math.random() * 6,
      height: 8 + Math.random() * 9,
      speed: 0.45 + Math.random() * 0.8,
      drift: (Math.random() - 0.5) * 0.35,
      angle: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.08,
      opacity: 0.42 + Math.random() * 0.28,
      color: colors[Math.floor(Math.random() * colors.length)]
    };
  }

  function draw() {
    context.clearRect(0, 0, width, height);
    pieces.forEach((piece, index) => {
      piece.y += piece.speed;
      piece.x += piece.drift + Math.sin(piece.y / 70 + index) * 0.12;
      piece.angle += piece.spin;

      if (piece.y > height + 24) Object.assign(piece, makePiece(true));
      if (piece.x < -20) piece.x = width + 20;
      if (piece.x > width + 20) piece.x = -20;

      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.angle);
      context.globalAlpha = piece.opacity;
      context.fillStyle = piece.color;
      context.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
      context.restore();
    });
    animationFrame = requestAnimationFrame(draw);
  }

  resize();
  for (let index = 0; index < 42; index += 1) pieces.push(makePiece());
  window.addEventListener("resize", resize, { passive: true });
  animationFrame = requestAnimationFrame(draw);

  window.addEventListener("pagehide", () => {
    cancelAnimationFrame(animationFrame);
  }, { once: true });
})();