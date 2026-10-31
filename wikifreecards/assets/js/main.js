/* WikiFreeCards — script du site de présentation
   1. Menu de navigation sur petit écran
   2. Visionneuse d'images (agrandissement des captures)
   Sans dépendance externe : fonctionne hors ligne et en ouvrant index.html directement. */
(function () {
  "use strict";

  /* ---------- 1. Menu mobile ---------- */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("main-nav");

  if (toggle && nav) {
    var closeNav = function () {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    };

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        closeNav();
        toggle.focus();
      }
    });

    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) closeNav();
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth > 1060) closeNav();
    });
  }

  /* ---------- Vidéo de présentation : lecture automatique avec le son ---------- */
  // Le site tente de lancer la vidéo avec le son. Si le navigateur le refuse
  // (cas fréquent lors d'une première visite), un bouton « Regarder la
  // présentation » permet de la lancer d'un clic, depuis le début et avec le son.
  var promo = document.getElementById("promo-video");
  if (promo) {
    var frame = promo.closest(".promo-frame");
    var playBtn = frame.querySelector(".promo-play");
    var missing = frame.querySelector(".promo-missing");
    var source = promo.querySelector("source");
    var isMissing = false;

    var showMissing = function () {
      isMissing = true;
      missing.hidden = false;
      playBtn.hidden = true;
      promo.removeAttribute("controls");
    };
    var showPlayButton = function () {
      if (!isMissing && promo.paused) playBtn.hidden = false;
    };

    if (source) source.addEventListener("error", showMissing);
    promo.addEventListener("error", showMissing);
    // L'erreur a pu survenir avant le chargement de ce script (attribut onerror de <source>).
    if (promo.hasAttribute("data-missing")) showMissing();

    playBtn.addEventListener("click", function () {
      promo.muted = false;
      if (promo.volume === 0) promo.volume = 1;
      promo.currentTime = 0;
      var p = promo.play();
      if (p && p.catch) p.catch(function () {});
    });
    promo.addEventListener("play", function () { playBtn.hidden = true; });

    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (isMissing) {
      // rien à lire
    } else if (reduceMotion) {
      showPlayButton();
    } else {
      promo.muted = false;
      var attempt = promo.play();
      if (attempt && attempt.catch) {
        attempt.catch(showPlayButton);
      } else {
        setTimeout(showPlayButton, 800);
      }
    }
  }

  /* ---------- Éventail de paquets : animation au premier affichage ---------- */
  var fanEl = document.querySelector(".pack-fan");
  if (fanEl) {
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          fanEl.classList.add("is-visible");
          io.disconnect();
        }
      }, { threshold: 0.3 });
      io.observe(fanEl);
    } else {
      fanEl.classList.add("is-visible");
    }
  }

  /* ---------- 2. Visionneuse d'images ---------- */
  var links = Array.prototype.slice.call(document.querySelectorAll("a[data-lightbox]"));
  var dialog = document.getElementById("lightbox");

  // Sans prise en charge de <dialog>, les liens ouvrent simplement l'image en grand.
  if (!links.length || !dialog || typeof dialog.showModal !== "function") return;

  var img = dialog.querySelector(".lb-stage img");
  var caption = dialog.querySelector(".lb-caption p");
  var count = dialog.querySelector(".lb-count");
  var prevBtn = dialog.querySelector("[data-lb='prev']");
  var nextBtn = dialog.querySelector("[data-lb='next']");
  var closeBtn = dialog.querySelector("[data-lb='close']");
  var fullLink = dialog.querySelector("[data-lb='full']");
  var current = 0;
  var opener = null;

  function captionFor(link) {
    var fig = link.closest("figure");
    var cap = fig ? fig.querySelector("figcaption") : null;
    if (cap) return cap.textContent.trim();
    var thumb = link.querySelector("img");
    return thumb ? thumb.alt : "";
  }

  function show(index) {
    current = (index + links.length) % links.length;
    var link = links[current];
    var thumb = link.querySelector("img");
    img.src = link.getAttribute("href");
    if (fullLink) fullLink.href = link.getAttribute("href");
    img.alt = thumb ? thumb.alt : "";
    caption.textContent = captionFor(link);
    count.textContent = (current + 1) + " / " + links.length;
    var single = links.length < 2;
    prevBtn.hidden = single;
    nextBtn.hidden = single;
  }

  links.forEach(function (link, i) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      opener = link;
      show(i);
      dialog.showModal();
      closeBtn.focus();
    });
  });

  prevBtn.addEventListener("click", function () { show(current - 1); });
  nextBtn.addEventListener("click", function () { show(current + 1); });
  closeBtn.addEventListener("click", function () { dialog.close(); });

  dialog.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(current - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(current + 1); }
  });

  // Un clic sur le fond (hors de l'image et des boutons) ferme la visionneuse.
  dialog.addEventListener("click", function (e) {
    if (e.target === dialog || e.target.classList.contains("lb-stage")) dialog.close();
  });

  dialog.addEventListener("close", function () {
    img.removeAttribute("src");
    if (opener) opener.focus();
  });
})();
