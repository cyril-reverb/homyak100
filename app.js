// ── Supabase ────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://boicjprjxlggawbihmzt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_oPpKFeZvqANRAoTG-wSSsA_Dlgm9t4X';
let db = null;

// ── State ──────────────────────────────────────────────────────────────────

const USERS = ['Nick', 'Matt', 'Friend'];
const USER_LABELS = { Nick: 'Nick', Matt: 'Matt', Friend: 'Friend of Homyak' };

let state = {
  currentUser: null,
  movies: [],      // { id, title, year, director, scores: { Nick: 0, Matt: 0, Friend: 0 } }
  battles: [],     // { a, b, winner, points, user, ts }
  battleA: null,
  battleB: null,
  leaderboardFilter: 'all',
};

const STORAGE_KEY = 'homyak100_v2';

function loadState() {
  let savedMovies = [];
  let savedBattles = [];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      savedMovies = saved.movies || [];
      savedBattles = saved.battles || [];
    }
  } catch (e) {}

  state.battles = savedBattles;

  // Build a score map from saved data keyed by title (titles are the stable identifier)
  const savedScores = {};
  for (const m of savedMovies) {
    savedScores[m.title] = m.scores || { Nick: 0, Matt: 0, Friend: 0 };
  }

  // Base roster is always MOVIES — preserving scores for known titles
  const canonicalTitles = new Set(MOVIES.map(m => m.title));
  state.movies = MOVIES.map((m, i) => ({
    id: i + 1,
    title: m.title,
    year: m.year,
    director: m.director,
    scores: savedScores[m.title] || { Nick: 0, Matt: 0, Friend: 0 },
  }));

  // Re-attach any custom user-added movies (titles not in the canonical list)
  let nextId = MOVIES.length + 1;
  for (const m of savedMovies) {
    if (!canonicalTitles.has(m.title)) {
      state.movies.push({ ...m, id: nextId++ });
    }
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    movies: state.movies,
    battles: state.battles,
  }));
}

// ── Supabase sync ───────────────────────────────────────────────────────────

async function syncFromSupabase() {
  if (!db) return;
  try {
    const [scoresRes, customRes] = await Promise.all([
      db.from('scores').select('*'),
      db.from('custom_movies').select('*'),
    ]);

    // Apply scores
    if (!scoresRes.error && scoresRes.data) {
      const scoreMap = {};
      for (const row of scoresRes.data) {
        scoreMap[row.movie_title] = { Nick: row.nick || 0, Matt: row.matt || 0, Friend: row.friend || 0 };
      }
      for (const movie of state.movies) {
        if (scoreMap[movie.title]) movie.scores = scoreMap[movie.title];
      }
    }

    // Merge custom movies
    if (!customRes.error && customRes.data) {
      const normalize = s => s.toLowerCase().replace(/^(the|a|an)\s+/i, '').replace(/[^a-z0-9\s]/g, '').trim();
      let nextId = Math.max(...state.movies.map(m => m.id), 0) + 1;
      for (const row of customRes.data) {
        // Match by supabaseId first (survives title renames), then fuzzy title
        let movie = state.movies.find(m => m.supabaseId === row.id)
                 || state.movies.find(m => m.isCustom && normalize(m.title) === normalize(row.title));

        if (movie) {
          // Update in-place — never overwrites canonical entries
          movie.title = row.title;
          movie.year = row.year;
          movie.director = row.director;
          movie.supabaseId = row.id;
        } else {
          // Check no canonical match before adding
          const canonicalMatch = state.movies.find(m => !m.isCustom && normalize(m.title) === normalize(row.title));
          if (!canonicalMatch) {
            state.movies.push({
              id: nextId++,
              title: row.title,
              year: row.year,
              director: row.director,
              supabaseId: row.id,
              isCustom: true,
              scores: { Nick: 0, Matt: 0, Friend: 0 },
            });
          }
        }
      }
    }

    saveState();

    if (state.currentUser) {
      renderLeaderboard();
      renderMoviesView();
      if (state.battleA) {
        renderBattleCard('a', state.battleA);
        renderBattleCard('b', state.battleB);
      }
    }
  } catch (e) {
    console.warn('Supabase sync failed, using local data');
  }
}

async function saveCustomMovieToSupabase(movie) {
  if (!db) return;
  try {
    if (movie.supabaseId) {
      // Update existing
      await db.from('custom_movies').update({ title: movie.title, year: movie.year, director: movie.director })
        .eq('id', movie.supabaseId);
    } else {
      // Insert new, get back ID
      const { data } = await db.from('custom_movies')
        .insert({ title: movie.title, year: movie.year, director: movie.director })
        .select().single();
      if (data) movie.supabaseId = data.id;
    }
    movie.isCustom = true;
    saveState();
  } catch (e) {
    console.warn('Failed to sync custom movie:', e);
  }
}

async function recordVoteToSupabase(movieTitle, user, points) {
  if (!db) return;
  try {
    const { error } = await db.rpc('increment_score', {
      p_movie_title: movieTitle,
      p_user: user,
      p_points: points,
    });
    if (error) console.warn('Supabase vote failed:', error);
  } catch (e) {
    console.warn('Supabase vote failed:', e);
  }
}

// ── Score helpers ───────────────────────────────────────────────────────────

function totalScore(movie) {
  return (movie.scores.Nick || 0) + (movie.scores.Matt || 0) + (movie.scores.Friend || 0);
}

function filteredScore(movie, filter) {
  if (filter === 'all') return totalScore(movie);
  return movie.scores[filter] || 0;
}

function getLeaderboard(filter) {
  return [...state.movies]
    .sort((a, b) => filteredScore(b, filter) - filteredScore(a, filter));
}

function getRank(movieId, filter) {
  const lb = getLeaderboard(filter);
  return lb.findIndex(m => m.id === movieId) + 1;
}

// ── User selection ──────────────────────────────────────────────────────────

function selectUser(user) {
  state.currentUser = user;
  document.getElementById('current-user-label').textContent = USER_LABELS[user];
  document.getElementById('screen-user').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  const view = currentHashView();
  showView(view, false);
  if (view !== 'leaderboard') renderLeaderboard();
  if (view !== 'movies') renderMoviesView();
  if (view === 'battle') newBattle();
}

function switchUser() {
  state.currentUser = null;
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-user').classList.add('active');
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VALID_VIEWS = ['battle', 'leaderboard', 'movies', 'stats'];

function currentHashView() {
  const hash = location.hash.replace('#', '');
  return VALID_VIEWS.includes(hash) ? hash : 'battle';
}

function showView(name, pushState = true) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (pushState) location.hash = name;
  if (name === 'leaderboard') renderLeaderboard();
  if (name === 'movies') renderMoviesView();
  if (name === 'stats') renderStatsView();
  if (name === 'battle' && !state.battleA) newBattle();
}

window.addEventListener('hashchange', () => {
  if (state.currentUser) showView(currentHashView(), false);
});

// ── Movie images & actors ────────────────────────────────────────────────────

const imageCache = {};
const actorsCache = {};

function extractActorsFromWikitext(wikitext) {
  const match = wikitext.match(/\|\s*starring\s*=\s*([\s\S]*?)(?=\n\s*\||\n\s*\}\}|\}\})/);
  if (!match) return [];
  const raw = match[1];
  const names = [...raw.matchAll(/\[\[([^\]|#:]+?)(?:\|[^\]]+)?\]\]/g)]
    .map(m => m[1].replace(/_/g, ' ').trim())
    .filter(n => n.length > 1 && !n.includes('(') );
  return names.slice(0, 3);
}

async function fetchMovieActors(title, year) {
  if (actorsCache[title] !== undefined) return actorsCache[title];
  actorsCache[title] = [];
  try {
    const pageTitles = [`${title} (film)`, `${title} (${year} film)`, title];
    for (const pageTitle of pageTitles) {
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=revisions&rvprop=content&rvslots=main&rvsection=0&format=json&origin=*`;
      const data = await fetch(url).then(r => r.json());
      const pages = data.query?.pages || {};
      const page = Object.values(pages)[0];
      if (page.missing !== undefined) continue;
      const wikitext = page.revisions?.[0]?.slots?.main?.['*'] || '';
      const actors = extractActorsFromWikitext(wikitext);
      if (actors.length) { actorsCache[title] = actors; return actors; }
    }
  } catch (e) {}
  return [];
}

function setCardActors(side, actors) {
  const el = document.getElementById('actors-' + side);
  if (!el) return;
  el.textContent = actors.length ? actors.join('  ·  ') : '';
}

async function fetchMovieImage(title, year) {
  const cacheKey = title;
  if (imageCache[cacheKey] !== undefined) return imageCache[cacheKey];
  imageCache[cacheKey] = null;

  const getSummary = async (pageTitle) => {
    try {
      const s = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`).then(r => r.json());
      if (s.type === 'disambiguation' || !s.extract) return null;
      return s;
    } catch { return null; }
  };

  const isFilmSummary = (s, yr) => {
    if (!s) return false;
    const extract = (s.extract || '').toLowerCase();
    if (!extract.includes('film') && !extract.includes('movie') && !extract.includes('directed')) return false;
    // Year check: if we know the year, the extract should mention it
    if (yr && !extract.includes(String(yr))) return false;
    return true;
  };

  try {
    // Try direct page names in order of likelihood
    const candidates = [
      `${title} (film)`,
      `${title} (${year} film)`,
      title,
    ];

    let img = null;
    for (const candidate of candidates) {
      const summary = await getSummary(candidate);
      if (isFilmSummary(summary, year) && summary.thumbnail?.source) {
        img = summary.thumbnail.source;
        break;
      }
    }

    // Fall back to search if direct lookups failed
    if (!img) {
      const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + ' ' + year + ' film')}&format=json&origin=*&srlimit=5`;
      const { query: q } = await fetch(searchUrl).then(r => r.json());
      const hits = (q && q.search) || [];
      for (const hit of hits) {
        const summary = await getSummary(hit.title);
        if (isFilmSummary(summary, year) && summary.thumbnail?.source) {
          img = summary.thumbnail.source;
          break;
        }
      }
    }

    imageCache[cacheKey] = img;
    return img;
  } catch (e) {
    return null;
  }
}

function setCardImage(side, url) {
  const el = document.getElementById('poster-' + side);
  if (!el) return;
  if (url) {
    el.style.backgroundImage = `url(${url})`;
    el.classList.remove('poster-empty');
  } else {
    el.style.backgroundImage = '';
    el.classList.add('poster-empty');
  }
}

// ── Battle ──────────────────────────────────────────────────────────────────

function pickTwoRandom() {
  const movies = state.movies;
  if (movies.length < 2) return [movies[0], movies[1]];
  let a, b;
  do {
    a = movies[Math.floor(Math.random() * movies.length)];
    b = movies[Math.floor(Math.random() * movies.length)];
  } while (a.id === b.id);
  return [a, b];
}

function newBattle() {
  document.getElementById('vote-result').classList.add('hidden');
  const [a, b] = pickTwoRandom();
  state.battleA = a;
  state.battleB = b;

  renderBattleCard('a', a);
  renderBattleCard('b', b);

  // Load posters + actors (show cached immediately, fetch if missing)
  ['a', 'b'].forEach(side => {
    const movie = side === 'a' ? a : b;

    // Image
    if (imageCache[movie.title]) {
      setCardImage(side, imageCache[movie.title]);
    } else {
      setCardImage(side, null);
      fetchMovieImage(movie.title, movie.year).then(url => setCardImage(side, url));
    }

    // Actors
    const cachedActors = movie.actors?.length ? movie.actors : actorsCache[movie.title];
    if (cachedActors?.length) {
      setCardActors(side, cachedActors);
    } else {
      setCardActors(side, []);
      fetchMovieActors(movie.title, movie.year).then(actors => {
        if (actors.length) {
          movie.actors = actors; // persist to state
          setCardActors(side, actors);
        }
      });
    }
  });

  // Re-enable buttons
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.disabled = false;
    btn.style.opacity = '1';
  });
}

function renderBattleCard(side, movie) {
  const rank = getRank(movie.id, 'all');
  const total = totalScore(movie);
  document.getElementById('rank-' + side).textContent =
    rank <= 100 ? `#${rank} in the Homyak 100` : `Ranked #${rank}`;
  document.getElementById('title-' + side).textContent = movie.title;
  document.getElementById('meta-' + side).textContent =
    `${movie.year}  ·  ${movie.director}`;
  document.getElementById('score-' + side).textContent =
    total === 0 ? 'No votes yet' : `${total} pts total`;
}

function vote(side, points) {
  const winner = side === 'a' ? state.battleA : state.battleB;
  const user = state.currentUser;

  winner.scores[user] = (winner.scores[user] || 0) + points;

  state.battles.push({
    a: state.battleA.id,
    b: state.battleB.id,
    winner: winner.id,
    points,
    user,
    ts: Date.now(),
  });

  saveState();
  recordVoteToSupabase(winner.title, user, points);

  // Show result
  const label = points === 3 ? 'much better' : 'better';
  document.getElementById('result-text').innerHTML =
    `<strong>${winner.title}</strong> wins — voted <em>${label}</em> (+${points} pts)`;
  document.getElementById('vote-result').classList.remove('hidden');

  // Disable buttons
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

function setFilter(filter) {
  state.leaderboardFilter = filter;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('filter-' + filter).classList.add('active');
  renderLeaderboard();
}

function renderLeaderboard() {
  const filter = state.leaderboardFilter;
  const ranked = getLeaderboard(filter);
  const container = document.getElementById('leaderboard-list');

  if (ranked.every(m => filteredScore(m, filter) === 0)) {
    container.innerHTML = `<div class="lb-empty">No votes yet — start a battle to build the leaderboard!</div>`;
    return;
  }

  let html = '';
  let passedCutoff = false;

  ranked.forEach((movie, i) => {
    const rank = i + 1;
    const score = filteredScore(movie, filter);

    if (rank === 101 && !passedCutoff) {
      passedCutoff = true;
      html += `<div class="lb-divider"><span class="lb-divider-label">— Outside the Homyak 100 —</span></div>`;
    }

    let rankDisplay = rank;
    let rankClass = '';
    if (rank === 1) { rankDisplay = '🥇'; rankClass = 'gold'; }
    else if (rank === 2) { rankDisplay = '🥈'; rankClass = 'silver'; }
    else if (rank === 3) { rankDisplay = '🥉'; rankClass = 'bronze'; }

    const rowClass = rank === 1 ? 'rank-1' : rank <= 10 ? 'top-10' : rank <= 100 ? 'top-100' : '';

    const breakdown = USERS.map(u => `${u[0]}:${movie.scores[u] || 0}`).join('  ');

    html += `
      <div class="lb-row ${rowClass}">
        <div class="lb-rank ${rankClass}">${rankDisplay}</div>
        <div class="lb-info">
          <div class="lb-title">${movie.title}</div>
          <div class="lb-meta">${movie.year} · ${movie.director}</div>
        </div>
        <div class="lb-scores">
          <div class="lb-total">${score} pts</div>
          ${filter === 'all' ? `<div class="lb-breakdown">${breakdown}</div>` : ''}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ── All Movies View ─────────────────────────────────────────────────────────

let movieSort = { col: 'pts', dir: 'desc' };

function setMovieSort(col) {
  if (movieSort.col === col) {
    movieSort.dir = movieSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    movieSort.col = col;
    movieSort.dir = col === 'pts' ? 'desc' : 'asc';
    if (col === 'added') movieSort.dir = 'asc';
  }
  renderMoviesView();
}

function renderMoviesView() {
  const query = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const ranked = getLeaderboard('all'); // base order by points for rank display

  let filtered = query
    ? ranked.filter(m =>
        m.title.toLowerCase().includes(query) ||
        m.director.toLowerCase().includes(query) ||
        String(m.year).includes(query))
    : [...ranked];

  // Apply sort
  filtered.sort((a, b) => {
    let av, bv;
    if (movieSort.col === 'title')      { av = a.title.toLowerCase();    bv = b.title.toLowerCase(); }
    else if (movieSort.col === 'year')  { av = a.year;                   bv = b.year; }
    else if (movieSort.col === 'director') { av = a.director.toLowerCase(); bv = b.director.toLowerCase(); }
    else if (movieSort.col === 'added') { av = a.id;                     bv = b.id; }
    else /* pts */                      { av = totalScore(a);             bv = totalScore(b); }
    if (av < bv) return movieSort.dir === 'asc' ? -1 : 1;
    if (av > bv) return movieSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  document.getElementById('movie-count').textContent = state.movies.length;

  if (query && filtered.length === 0) {
    const displayTitle = (document.getElementById('search-input')?.value || '').trim();
    document.getElementById('movies-list').innerHTML = `
      <div class="no-results">
        <p>No movie matching "<strong>${displayTitle}</strong>" in the list.</p>
        <button class="add-from-search-btn" onclick="addFromSearch()">+ Add "${displayTitle}"</button>
        <div id="inline-lookup-status" class="lookup-status"></div>
        <div id="inline-add-details" class="inline-add-details hidden">
          <div class="inline-fields">
            <input type="number" id="inline-year" placeholder="Year" min="1888" max="2030" />
            <input type="text" id="inline-director" placeholder="Director" />
            <button onclick="confirmAddFromSearch()">Add to list</button>
          </div>
        </div>
      </div>`;
    return;
  }

  const arrow = (col) => {
    if (movieSort.col !== col) return '<span class="sort-arrow inactive">↕</span>';
    return `<span class="sort-arrow">${movieSort.dir === 'asc' ? '↑' : '↓'}</span>`;
  };

  let html = `<table class="movies-table">
    <thead><tr>
      <th class="col-rank sortable" onclick="setMovieSort('added')" title="Sort by order added"># ${arrow('added')}</th>
      <th class="sortable" onclick="setMovieSort('title')">Title ${arrow('title')}</th>
      <th class="col-year sortable" onclick="setMovieSort('year')">Year ${arrow('year')}</th>
      <th class="col-director sortable" onclick="setMovieSort('director')">Director ${arrow('director')}</th>
      <th class="col-score sortable" onclick="setMovieSort('pts')">Pts ${arrow('pts')}</th>
      <th class="col-edit"></th>
    </tr></thead><tbody>`;

  filtered.forEach(movie => {
    const rank = getRank(movie.id, 'all');
    const score = totalScore(movie);
    html += `<tr id="movie-row-${movie.id}">
      <td class="col-rank">${rank}</td>
      <td class="col-title">${movie.title}</td>
      <td class="col-year">${movie.year}</td>
      <td class="col-director">${movie.director}</td>
      <td class="col-score">${score}</td>
      <td class="col-edit"><button class="edit-btn" onclick="startEdit(${movie.id})">Edit</button></td>
    </tr>`;
  });

  html += '</tbody></table>';
  document.getElementById('movies-list').innerHTML = html;
}

function startEdit(movieId) {
  const movie = state.movies.find(m => m.id === movieId);
  if (!movie) return;
  const row = document.getElementById('movie-row-' + movieId);
  if (!row) return;
  const rank = getRank(movieId, 'all');
  const score = totalScore(movie);
  const actorsVal = (movie.actors || []).join(', ').replace(/"/g, '&quot;');
  row.innerHTML = `
    <td class="col-rank">${rank}</td>
    <td class="col-title"><input class="edit-input" id="edit-title-${movieId}" value="${movie.title.replace(/"/g, '&quot;')}" /></td>
    <td class="col-year"><input class="edit-input edit-input-year" id="edit-year-${movieId}" type="number" value="${movie.year}" /></td>
    <td class="col-director"><input class="edit-input" id="edit-director-${movieId}" value="${movie.director.replace(/"/g, '&quot;')}" /></td>
    <td class="col-score">${score}</td>
    <td class="col-edit edit-actions">
      <button class="save-btn" onclick="saveEdit(${movieId})">Save</button>
      <button class="cancel-edit-btn" onclick="renderMoviesView()">✕</button>
    </td>
    <td colspan="6" class="edit-actors-row">
      <label class="edit-actors-label">Actors (comma-separated)</label>
      <input class="edit-input edit-input-actors" id="edit-actors-${movieId}" placeholder="e.g. Tom Hanks, Robin Wright" value="${actorsVal}" />
    </td>`;
  document.getElementById('edit-title-' + movieId).focus();
}

function saveEdit(movieId) {
  const movie = state.movies.find(m => m.id === movieId);
  if (!movie) return;
  const title = document.getElementById('edit-title-' + movieId)?.value.trim();
  const year = parseInt(document.getElementById('edit-year-' + movieId)?.value);
  const director = document.getElementById('edit-director-' + movieId)?.value.trim();
  if (!title || !year || !director) { alert('All fields required.'); return; }
  const actorsRaw = document.getElementById('edit-actors-' + movieId)?.value || '';
  movie.title = title;
  movie.year = year;
  movie.director = director;
  movie.actors = actorsRaw.split(',').map(a => a.trim()).filter(Boolean);
  movie.isCustom = true;
  actorsCache[title] = movie.actors; // update cache too
  saveState();
  saveCustomMovieToSupabase(movie);
  renderMoviesView();
}

async function addFromSearch() {
  const title = (document.getElementById('search-input')?.value || '').trim();
  if (!title) return;

  const statusEl = document.getElementById('inline-lookup-status');
  const detailsEl = document.getElementById('inline-add-details');
  if (statusEl) { statusEl.textContent = 'Looking up…'; statusEl.className = 'lookup-status loading'; }

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + ' film')}&format=json&origin=*&srlimit=5`;
    const searchData = await fetch(searchUrl).then(r => r.json());
    const hits = (searchData.query && searchData.query.search) || [];

    let year = '', director = '';
    if (hits.length) {
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hits[0].title)}`;
      const summary = await fetch(summaryUrl).then(r => r.json());
      const extract = summary.extract || '';
      const yearMatch = extract.match(/\bis an? (\d{4})\b/);
      const dirMatch = extract.match(/directed by ([A-Z][a-zÀ-ÖØ-öø-ÿ\-']+(?:\s+[A-Z][a-zÀ-ÖØ-öø-ÿ\-']+){1,3})/);
      year = yearMatch ? parseInt(yearMatch[1]) : '';
      director = dirMatch ? dirMatch[1].replace(/\s*\[.*?\]/g, '').trim() : '';
    }

    if (statusEl) {
      statusEl.textContent = year || director ? `Found: ${title} (${year || '?'})` : 'Couldn\'t auto-fill — enter details below.';
      statusEl.className = 'lookup-status ' + (year || director ? 'ok' : 'warn');
    }
    if (detailsEl) {
      detailsEl.classList.remove('hidden');
      const yearEl = document.getElementById('inline-year');
      const dirEl = document.getElementById('inline-director');
      if (yearEl && year) yearEl.value = year;
      if (dirEl && director) dirEl.value = director;
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Lookup failed — enter details below.'; statusEl.className = 'lookup-status warn'; }
    if (detailsEl) detailsEl.classList.remove('hidden');
  }
}

function confirmAddFromSearch() {
  const title = (document.getElementById('search-input')?.value || '').trim();
  const year = parseInt(document.getElementById('inline-year')?.value || '');
  const director = (document.getElementById('inline-director')?.value || '').trim();

  if (!year || !director) {
    alert('Please fill in year and director.');
    return;
  }
  if (state.movies.some(m => m.title.toLowerCase() === title.toLowerCase())) {
    alert('That movie is already in the list.');
    return;
  }

  const newId = Math.max(...state.movies.map(m => m.id), 0) + 1;
  const movie = { id: newId, title, year, director, isCustom: true, scores: { Nick: 0, Matt: 0, Friend: 0 } };
  state.movies.push(movie);
  saveState();
  saveCustomMovieToSupabase(movie);

  document.getElementById('search-input').value = '';
  renderMoviesView();
}

let lookupTimer = null;

function showAddMovie() {
  document.getElementById('add-movie-form').classList.remove('hidden');
  document.getElementById('new-title').focus();
}

function hideAddMovie() {
  document.getElementById('add-movie-form').classList.add('hidden');
  document.getElementById('new-title').value = '';
  document.getElementById('new-year').value = '';
  document.getElementById('new-director').value = '';
  clearLookupStatus();
}

function setLookupStatus(msg, type) {
  const el = document.getElementById('lookup-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'lookup-status ' + (type || '');
}

function clearLookupStatus() {
  setLookupStatus('', '');
}

function onTitleInput() {
  clearTimeout(lookupTimer);
  const title = document.getElementById('new-title').value.trim();
  if (title.length < 2) { clearLookupStatus(); return; }
  setLookupStatus('Looking up…', 'loading');
  lookupTimer = setTimeout(() => lookupMovie(title), 600);
}

async function lookupMovie(title) {
  try {
    // Step 1: search Wikipedia for the movie page
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + ' film')}&format=json&origin=*&srlimit=5`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    const hits = (searchData.query && searchData.query.search) || [];

    if (!hits.length) {
      setLookupStatus('No match found — fill in manually.', 'warn');
      return;
    }

    // Step 2: fetch the summary of the best hit
    const pageTitle = hits[0].title;
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    const summaryRes = await fetch(summaryUrl);
    const summary = await summaryRes.json();
    const extract = summary.extract || '';

    // Parse year: "is a YYYY" or "is an YYYY"
    const yearMatch = extract.match(/\bis an? (\d{4})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : '';

    // Parse director: "directed by Firstname Lastname"
    const dirMatch = extract.match(/directed by ([A-Z][a-zÀ-ÖØ-öø-ÿ\-']+(?:\s+[A-Z][a-zÀ-ÖØ-öø-ÿ\-']+){1,3})/);
    const director = dirMatch ? dirMatch[1].replace(/\s*\[.*?\]/g, '').trim() : '';

    if (!year && !director) {
      setLookupStatus(`Found "${pageTitle}" but couldn't parse details — fill in manually.`, 'warn');
      return;
    }

    const yearEl = document.getElementById('new-year');
    const dirEl = document.getElementById('new-director');
    if (year && !yearEl.value) yearEl.value = year;
    if (director && !dirEl.value) dirEl.value = director;

    setLookupStatus(`Found: ${pageTitle} (${year || '?'})`, 'ok');
  } catch (e) {
    setLookupStatus('Lookup failed — fill in manually.', 'warn');
  }
}

function addMovie() {
  const title = document.getElementById('new-title').value.trim();
  const year = parseInt(document.getElementById('new-year').value);
  const director = document.getElementById('new-director').value.trim();

  if (!title || !year || !director) {
    alert('Please fill in title, year, and director.');
    return;
  }

  if (state.movies.some(m => m.title.toLowerCase() === title.toLowerCase())) {
    alert('That movie is already in the list.');
    return;
  }

  const newId = Math.max(...state.movies.map(m => m.id), 0) + 1;
  const movie = { id: newId, title, year, director, isCustom: true, scores: { Nick: 0, Matt: 0, Friend: 0 } };
  state.movies.push(movie);

  saveState();
  saveCustomMovieToSupabase(movie);
  hideAddMovie();
  renderMoviesView();
}

// ── Stats ────────────────────────────────────────────────────────────────────

let statsScope = 'all'; // 'all' | 'top100'

function setStatsScope(scope) {
  statsScope = scope;
  document.querySelectorAll('.stats-toggle-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('stats-toggle-' + scope).classList.add('active');
  renderStatsView();
}

function renderStatsView() {
  const ranked = getLeaderboard('all');
  const movies = statsScope === 'top100' ? ranked.slice(0, 100) : ranked;

  const barRow = (label, count, max, sub) => `
    <div class="stat-row">
      <div class="stat-label">${label}${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>
      <div class="stat-bar-wrap">
        <div class="stat-bar" style="width:${Math.round((count / max) * 100)}%"></div>
      </div>
      <div class="stat-count">${count}</div>
    </div>`;

  // By director (2+ films only)
  const byDirector = {};
  for (const m of movies) byDirector[m.director] = (byDirector[m.director] || 0) + 1;
  const directors = Object.entries(byDirector).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  const maxDir = directors[0]?.[1] || 1;

  // By actor
  const byActor = {};
  for (const m of movies) for (const a of (m.actors || [])) { if (a) byActor[a] = (byActor[a] || 0) + 1; }
  const actors = Object.entries(byActor).sort((a, b) => b[1] - a[1]);
  const maxAct = actors[0]?.[1] || 1;

  // By decade
  const byDecade = {};
  for (const m of movies) { const d = Math.floor(m.year / 10) * 10; byDecade[d] = (byDecade[d] || 0) + 1; }
  const decades = Object.entries(byDecade).sort((a, b) => a[0] - b[0]);
  const maxDec = Math.max(...decades.map(d => d[1]));

  document.getElementById('stats-directors').innerHTML = directors.length
    ? directors.map(([name, count]) => barRow(name, count, maxDir)).join('')
    : '<p class="stat-empty">No directors with 2+ films in this set.</p>';

  document.getElementById('stats-actors').innerHTML = actors.length
    ? actors.map(([name, count]) => barRow(name, count, maxAct)).join('')
    : '<p class="stat-empty">Vote in more battles to populate actors.</p>';

  document.getElementById('stats-decades').innerHTML =
    decades.map(([decade, count]) => barRow(`${decade}s`, count, maxDec, ` · ${count} film${count > 1 ? 's' : ''}`)).join('');
}

// ── Init ────────────────────────────────────────────────────────────────────

loadState();
db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
syncFromSupabase();
