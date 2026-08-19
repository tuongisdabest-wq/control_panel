// ================= THÊM MỚI: LỊCH CHIẾU — gộp KKPhim + VSMOV vào D1 schedule_cache =================
// Đặt ở top-level (ngoài export default) vì cần dùng chung cho cả scheduled() (cron mỗi 6h)
// và endpoint /admin/sync-schedule (trigger tay để test). KHÔNG đụng gì tới code fetch() gốc.

const SCHEDULE_TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3MDUxYjI1NWMyNDMyZDBhOTgxZjE4MTlmMDYwYjViYSIsIm5iZiI6MTc4MzI2MzI4MC43NDMsInN1YiI6IjZhNGE3MDMwYzcyMjc1NGFiNzUyMWI3NiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.4ARUeBsQbyRRBNOWR51f_swwzThKEgyIlZlcsIkb4x0"; // TRÙNG với TMDB_TOKEN khai báo trong fetch() — giữ 2 bản riêng vì scheduled() không thấy được biến cục bộ trong fetch()
const SCHEDULE_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// THÊM MỚI (v29): "khử độc" 1 giá trị trước khi bind vào D1 — D1 chỉ chấp nhận
// string/number/null (không chấp nhận object/array/undefined/NaN), nếu không sẽ throw
// D1_TYPE_ERROR và làm hỏng CẢ CHUNK 50 item cùng lúc (không phải chỉ 1 item lỗi).
// Hàm này ép mọi giá trị lạ về null thay vì để D1 tự throw, kèm log ra console để biết
// item/field nào đang có dữ liệu bất thường (xem trong Cloudflare Logs khi debug).
function sanitizeD1Value(value, fieldNameForLog) {
  if (value === undefined || value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  // object/array lọt tới đây tức là 1 trong các hàm normalize*/inferWeekday... đang trả
  // sai kiểu (VD nguồn API đổi field bất ngờ) — log lại để soi, nhưng KHÔNG throw, chỉ
  // ghi null để không làm hỏng cả batch ghi D1.
  console.log(`[schedule_cache] sanitizeD1Value: field "${fieldNameForLog}" là kiểu lạ (${t}), ép về null. Giá trị gốc:`, JSON.stringify(value)?.slice(0, 200));
  return null;
}

// Lấy JSON, timeout ngắn, không chặn cả job nếu 1 nguồn lỗi/chậm (trả mảng rỗng thay vì throw)
async function fetchJsonSafe(targetUrl, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(targetUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': SCHEDULE_BROWSER_UA },
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Chuẩn hoá 1 item KKPhim (danh-sach/phim-moi-cap-nhat) về shape chung
function normalizeKkItem(item) {
  if (!item) return null;
  return {
    tmdb_id: item.tmdb?.id ? Number(item.tmdb.id) : null,
    tmdb_type: item.tmdb?.type || (item.type === 'series' ? 'tv' : 'movie'),
    name: item.name || item.origin_name || '',
    origin_name: item.origin_name || null,
    poster_url: item.poster_url || item.thumb_url || null,
    slug: item.slug || null,
    modified_time: item.modified?.time || null,
    imdb_score: item.tmdb?.vote_average != null ? Number(item.tmdb.vote_average) : null,
    source: 'KK'
  };
}

// Chuẩn hoá 1 item VSMOV — GIẢ ĐỊNH cùng convention field với KKPhim (tmdb.id/type/vote_average,
// modified.time, slug, name, origin_name, poster_url/thumb_url). ĐÃ XÁC NHẬN qua trang chi tiết
// VSMOV có hiển thị thẳng "TMDB · movie · ID: xxx" nên field tmdb chắc chắn tồn tại; nếu tên field
// lệch (vd viết hoa khác, lồng cấp khác) thì log ở dưới (console.log trong syncScheduleCache) sẽ
// lộ ra ngay lần cron đầu tiên chạy thật — lúc đó chỉ cần sửa lại đúng field trong hàm này.
function normalizeVsItem(item) {
  if (!item) return null;
  return {
    tmdb_id: item.tmdb?.id ? Number(item.tmdb.id) : null,
    tmdb_type: item.tmdb?.type || (item.type === 'series' ? 'tv' : 'movie'),
    name: item.name || item.origin_name || '',
    origin_name: item.origin_name || null,
    poster_url: item.poster_url || item.thumb_url || null,
    slug: item.slug || null,
    modified_time: item.modified?.time || null,
    imdb_score: item.tmdb?.vote_average != null ? Number(item.tmdb.vote_average) : null,
    source: 'VS'
  };
}

// Gọi vài trang đầu của 1 endpoint danh-sách (đủ phủ tuần gần nhất, không cần quét hết)
async function fetchListPages(baseUrl, maxPages = 3) {
  const allItems = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJsonSafe(`${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${page}`);
    // KKPhim/VSMOV đều trả items ở data.items (danh-sách) hoặc data.data.items (tuỳ endpoint) —
    // thử cả 2 dạng để không vỡ nếu 1 trong 2 nguồn lồng cấp khác nhau.
    const items = data?.items || data?.data?.items || [];
    if (!items.length) break; // hết trang hoặc lỗi -> dừng sớm, không cố gọi tiếp
    allItems.push(...items);
  }
  return allItems;
}

// Với phim đã có tmdb_id + là series (tv): lấy NGÀY CHIẾU TẬP KẾ TIẾP thật từ TMDB
// (field `next_episode_to_air`), KHÔNG suy đoán weekday từ pattern quá khứ nữa.
// SỬA v31: trước đây (v30) suy `weekday` (0-6, thứ trong tuần) từ 5 tập ĐÃ air gần nhất —
// nghĩa là "phim này thường chiếu thứ mấy", rồi gán CỐ ĐỊNH weekday đó cho phim, hiện lặp lại
// mãi mãi trong tab tương ứng dù tuần đó có tập mới hay không (đang nghỉ giữa mùa, đã hết mùa
// chờ mùa sau...). v30 chỉ giải quyết được case ĐÃ hoàn tất hẳn (Ended/Canceled), chứ không giải
// quyết được "tuần này có thật sự có tập mới không". Giờ đổi hẳn sang lưu next_air_date (ngày cụ
// thể, VD '2026-08-12') lấy thẳng từ next_episode_to_air.air_date mà TMDB đã tính sẵn cho chúng
// ta — đúng bản chất "ngày nào sẽ có tập mới" thay vì "thường chiếu thứ mấy".
//
// Trả về:
//   - string ISO date (VD '2026-08-12') = đã xác định được ngày air tập kế tiếp.
//   - '' (chuỗi rỗng, sentinel KHÁC null) = đã XÁC NHẬN hiện không có tập nào sắp air (đã
//     Ended/Canceled, hoặc đang Returning Series nhưng TMDB chưa có next_episode_to_air — giữa
//     mùa/chưa công bố lịch mùa sau) -> ghi đè tường minh để dọn next_air_date cũ đã cũ/sai
//     (xem UPSERT dùng COALESCE bên dưới — nếu trả null, COALESCE sẽ GIỮ NGUYÊN giá trị cũ,
//     không dọn được ngày cũ đã qua).
//   - null = CHƯA xác định được (lỗi mạng, timeout...) -> KHÔNG ghi đè giá trị cũ trong D1.
async function getNextAirDate(tmdbId) {
  try {
    const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?language=en-US`, {
      headers: { 'Authorization': `Bearer ${SCHEDULE_TMDB_TOKEN}`, 'Accept': 'application/json' }
    });
    if (!showRes.ok) return null;
    const show = await showRes.json();

    // Đã hoàn tất hẳn -> chắc chắn không còn tập mới, dọn sạch next_air_date cũ.
    if (show?.status === 'Ended' || show?.status === 'Canceled') return '';

    // TMDB tự tính sẵn next_episode_to_air (dựa trên lịch chiếu thật họ theo dõi, không phải
    // suy đoán từ pattern) — chỉ cần lấy air_date của nó. null/undefined nghĩa là hiện không có
    // tập nào được lên lịch công khai (giữa mùa, chờ công bố mùa sau...) -> cũng là '' (không
    // thuộc Lịch Chiếu lúc này), KHÔNG phải "chưa biết" vì TMDB đã trả lời rõ ràng là không có.
    const nextAirDate = show?.next_episode_to_air?.air_date || '';
    return nextAirDate;
  } catch (e) {
    return null;
  }
}

// ================= BADGE SONG NGỮ — BẢN DÙNG CHO scheduled() (v36) =================
// Bản sao module-level của 3 hàm vốn đang nằm trong fetch() (extractVsmovEmbed/fetchVsmovDetail/
// resolveVsmov) — CÙNG LÝ DO với SCHEDULE_BROWSER_UA ở trên: scheduled() không thấy được biến/hàm
// cục bộ khai báo bên trong fetch(). resolveVsmovForSchedule khác bản gốc ở chỗ nhận thẳng `origin`
// thay vì đọc từ `url.origin` (scheduled() không có `url` của request), và bỏ qua phần cache-write
// m3u8 qua ctx.waitUntil nếu không có ctx (cron luôn có ctx nên thực ra vẫn cache được).
function extractVsmovEmbedForSchedule(detail) {
  const episodes = detail?.movie ? detail.episodes : null;
  const firstServer = episodes?.[0]?.server_data?.[0];
  const linkEmbed = firstServer?.link_embed || '';
  const m = String(linkEmbed).match(/^https?:\/\/([a-zA-Z0-9-]+\.streamvsmov\.com)\/video\/([a-zA-Z0-9-]+)/);
  if (!m) return null;
  return { host: m[1], hash: m[2] };
}

async function fetchVsmovDetailForSchedule(slug) {
  try {
    const res = await fetch(`https://vsmov.com/api/phim/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': SCHEDULE_BROWSER_UA }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.status || !data?.movie) return null;
    return data;
  } catch (e) { return null; }
}

// Chỉ cần subtitles để xét badge — KHÔNG cần dựng m3u8/origin proxy như bản gốc dùng cho player,
// nên bỏ hẳn phần đó, đỡ phải truyền origin giả từ scheduled().
async function resolveVsmovSubsOnlyForSchedule(env, hash, host) {
  if (!hash || !/^[a-zA-Z0-9-]+$/.test(hash)) return { error: 'invalid_hash' };
  if (!host || !/^[a-zA-Z0-9-]+\.streamvsmov\.com$/.test(host)) return { error: 'invalid_host' };

  const kvKey = `vsmov_resolve:${host}:${hash}`;
  if (env.RECOMMENDED_KV) {
    const cached = await env.RECOMMENDED_KV.get(kvKey, 'json');
    if (cached) return cached; // cache này dùng chung với resolver gốc trong fetch(), có sẵn subtitles
  }

  const baseUrl = `https://${host}`;
  let html;
  try {
    const res = await fetch(`${baseUrl}/video/${hash}`, { headers: { 'User-Agent': SCHEDULE_BROWSER_UA } });
    if (!res.ok) return { error: `embed_fetch_failed_${res.status}` };
    html = await res.text();
  } catch (e) {
    return { error: 'embed_fetch_exception', detail: String(e) };
  }

  const CODE_LABELS = { vie: 'Tiếng Việt', eng: 'English' };
  let subtitles = [];
  const subMatch = html.match(/subtitles:\s*(\[.*?\])/s);
  if (subMatch) {
    try {
      const rawSubs = JSON.parse(subMatch[1]);
      subtitles = rawSubs
        .map((s) => ({
          code: s.code || 'unk',
          label: CODE_LABELS[s.code] || (s.code ? s.code.toUpperCase() : 'Khác'),
          url: s.url ? (String(s.url).startsWith('http') ? s.url : baseUrl + s.url) : null
        }))
        .filter((s) => s.url);
    } catch (e) { /* bỏ qua */ }
  }
  // Không cache lại ở đây (thiếu m3u8 nên khác shape bản gốc) — chỉ ĐỌC cache có sẵn ở trên nếu có.
  return { subtitles };
}

// Quét 1 TRANG danh sách "phim mới cập nhật" VSMOV -> gắn badge cho phim có sub 'vie'. Dùng chung
// cho cả route POST /admin/bilingual-scan (gọi tay) và scheduled() (cron tự động) — trước v36 logic
// này chỉ nằm trong route, cron không gọi được nên phải trích ra đây.
async function runBilingualScanPage(env, page) {
  const listData = await fetchJsonSafe(`https://vsmov.com/api/danh-sach/phim-moi-cap-nhat?page=${page}`);
  const items = listData?.items || listData?.data?.items || [];
  if (!items.length) {
    // Hết dữ liệu (đã quét tới trang cuối catalog VSMOV). THÊM MỚI (v36): reset cursor về trang 1
    // thay vì giữ nguyên page cũ — vì giờ có cron chạy liên tục (không chỉ bấm tay 1 lần), nếu giữ
    // nguyên cursor thì mọi tick sau sẽ mãi mãi gọi lại đúng trang rỗng đó, vô ích. Reset về đầu để
    // vòng quét tiếp theo tự phát hiện phim MỚI được VSMOV thêm vào đầu danh sách "mới cập nhật"
    // (existingSlugs đã có sẵn nên quét lại từ đầu không tốn công gắn trùng badge cũ).
    await env.RECOMMENDED_KV.put('bilingual_scan_cursor', '1');
    return { page, scanned: 0, newlyBadged: [], noMoreData: true };
  }

  const existingRaw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  const existingSlugs = new Set(existing.map(c => c.slug));

  const newlyBadged = [];
  for (const item of items) {
    const slug = item?.slug;
    if (!slug || existingSlugs.has(slug)) continue;
    const detail = await fetchVsmovDetailForSchedule(slug);
    const embed = extractVsmovEmbedForSchedule(detail);
    if (!embed) continue;
    const resolved = await resolveVsmovSubsOnlyForSchedule(env, embed.hash, embed.host);
    const hasVieSub = resolved?.subtitles?.some(s => s.code === 'vie');
    if (hasVieSub) {
      newlyBadged.push({
        slug,
        sourceProvider: 'vsmov',
        name: detail.movie.name || item.name || '',
        poster_url: detail.movie.poster_url || item.poster_url || null,
        thumb_url: detail.movie.thumb_url || item.thumb_url || null,
        subtitleLangs: resolved.subtitles.map(s => s.code),
        tmdbId: detail.movie?.tmdb?.id ? String(detail.movie.tmdb.id) : null,
        foundAt: new Date().toISOString()
      });
      existingSlugs.add(slug);
    }
  }

  if (newlyBadged.length > 0) {
    const merged = [...existing, ...newlyBadged];
    await env.RECOMMENDED_KV.put('bilingual_auto_list', JSON.stringify(merged));
  }
  await env.RECOMMENDED_KV.put('bilingual_scan_cursor', String(page + 1));

  return { page, scanned: items.length, newlyBadged, nextPage: page + 1 };
}

// Hàm chính: gọi cả 2 nguồn, gộp theo tmdb_id, ghi D1. Gọi từ scheduled() (cron) hoặc
// /admin/sync-schedule (trigger tay). Trả về số lượng đã đồng bộ để log/debug.
async function syncScheduleCache(env) {
  if (!env.DB) return { error: 'db_not_configured' };

  const [kkRaw, vsRaw, vsDangChieuRaw] = await Promise.all([
    fetchListPages('https://phimapi.com/danh-sach/phim-moi-cap-nhat', 3),
    fetchListPages('https://vsmov.com/api/danh-sach/phim-moi-cap-nhat', 3),
    fetchListPages('https://vsmov.com/api/danh-sach/dang-chieu', 2)
  ]);

  const merged = new Map(); // key: tmdb_id

  for (const raw of kkRaw) {
    const n = normalizeKkItem(raw);
    if (!n || !n.tmdb_id) continue; // bỏ qua phim không có tmdb_id — không đủ để suy weekday/gộp nguồn
    merged.set(n.tmdb_id, { ...n, slug_kk: n.slug, slug_vs: null, source_only: 'KK' });
  }

  for (const raw of [...vsRaw, ...vsDangChieuRaw]) {
    const n = normalizeVsItem(raw);
    if (!n || !n.tmdb_id) continue;
    const existing = merged.get(n.tmdb_id);
    if (existing) {
      // Đã có từ KKPhim -> gộp, giữ slug KK để mở phim (nguồn chính của site), chỉ bổ sung slug_vs
      existing.slug_vs = n.slug;
      existing.source_only = 'BOTH';
      // Field nào KK thiếu thì lấy tạm từ VSMOV bù vào (poster/imdb...)
      if (!existing.poster_url) existing.poster_url = n.poster_url;
      if (existing.imdb_score == null) existing.imdb_score = n.imdb_score;
    } else {
      merged.set(n.tmdb_id, { ...n, slug_kk: null, slug_vs: n.slug, source_only: 'VS' });
    }
  }

  const items = [...merged.values()];

  // Lấy next_air_date cho phim dạng series — giới hạn số lượng gọi TMDB mỗi lần chạy để tránh
  // vượt quota/timeout Worker (cron chạy mỗi 6h nên phim còn lại sẽ được lấy nốt ở lần chạy sau).
  // GHI CHÚ v31: it.next_air_date có thể là 1 trong 3 dạng — string ISO date (đã xác định ngày
  // air tập kế tiếp), null (chưa xác định được, giữ nguyên giá trị cũ khi ghi D1 nhờ COALESCE
  // bên dưới), hoặc '' chuỗi rỗng (đã XÁC NHẬN hiện không có tập nào sắp air — ghi đè tường minh
  // để dọn next_air_date cũ đã qua/sai, xem getNextAirDate() để hiểu rõ 3 trường hợp này).
  //
  // SỬA v32: BUG PHÁT HIỆN QUA TEST THỰC TẾ — trước đây luôn lấy 40 item ĐẦU TIÊN theo đúng thứ
  // tự `items` (thứ tự này lấy từ API "phim mới cập nhật" của nguồn, gần như KHÔNG đổi giữa các
  // lần cron chạy cách nhau vài giờ) -> mọi lần chạy đều tra lại Y HỆT 40 phim đó (đã kiểm chứng:
  // chạy 5 lần liên tiếp cách 5s, next_air_date_lookups_this_run luôn = 40, kk_count/vs_count y
  // hệt nhau). Hậu quả: phim nào KHÔNG nằm trong top 40 sẽ KHÔNG BAO GIỜ được tra lại TMDB, next_
  // air_date bị "đứng hình" ở giá trị cũ mãi mãi (kể cả khi tập đó đã chiếu xong từ lâu) cho tới
  // khi nó tình cờ trồi lên top 40 do nguồn cập nhật. Giờ đổi sang ưu tiên tra phim có last_synced
  // CŨ NHẤT trước (phim chưa từng sync — last_synced null/rỗng — được ưu tiên cao nhất), giống cơ
  // chế round-robin: sau vài lần chạy, MỌI phim series đều lần lượt được xoay vòng tra tới, không
  // còn phim nào bị bỏ quên vĩnh viễn.
  let lastSyncedMap = new Map(); // tmdb_id -> last_synced (ISO string) đọc từ D1 trước khi tra
  try {
    const { results: syncedRows } = await env.DB.prepare(
      `SELECT tmdb_id, last_synced FROM schedule_cache WHERE tmdb_type = 'tv'`
    ).all();
    for (const row of (syncedRows || [])) lastSyncedMap.set(row.tmdb_id, row.last_synced || '');
  } catch (e) {
    // Lỗi đọc (VD lần đầu chưa có bảng/dữ liệu) -> coi như tất cả đều "chưa từng sync", vẫn tra
    // bình thường theo thứ tự items gốc, không chặn cả job.
    console.log('[schedule_cache] Lỗi đọc last_synced cũ để xếp ưu tiên (bỏ qua, coi tất cả là mới):', String(e));
  }

  const tvItemsByOldestSync = items
    .filter(it => it.tmdb_type === 'tv')
    .sort((a, b) => {
      const aTime = lastSyncedMap.get(a.tmdb_id) ?? ''; // chưa từng sync -> '' luôn xếp trước (ưu tiên tra)
      const bTime = lastSyncedMap.get(b.tmdb_id) ?? '';
      return aTime < bTime ? -1 : (aTime > bTime ? 1 : 0);
    });

  const MAX_TMDB_LOOKUPS_PER_RUN = 40;
  let lookups = 0;
  for (const it of tvItemsByOldestSync) {
    if (lookups >= MAX_TMDB_LOOKUPS_PER_RUN) break;
    it.next_air_date = await getNextAirDate(it.tmdb_id); // `it` cùng tham chiếu object với phần tử trong `items` -> ghi D1 bên dưới vẫn thấy giá trị mới
    lookups++;
  }

  // Ghi D1 theo batch (D1 giới hạn số câu lệnh/1 batch, chia nhỏ 50 item/lần cho an toàn)
  const now = new Date().toISOString();
  const CHUNK = 50;
  let written = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    const stmts = chunk.map(it => env.DB.prepare(
      `INSERT INTO schedule_cache
        (tmdb_id, tmdb_type, name, origin_name, poster_url, slug_kk, slug_vs, source_only, next_air_date, imdb_score, modified_time, last_synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tmdb_id) DO UPDATE SET
         tmdb_type = excluded.tmdb_type,
         name = excluded.name,
         origin_name = excluded.origin_name,
         poster_url = excluded.poster_url,
         slug_kk = COALESCE(excluded.slug_kk, schedule_cache.slug_kk),
         slug_vs = COALESCE(excluded.slug_vs, schedule_cache.slug_vs),
         source_only = excluded.source_only,
         next_air_date = COALESCE(excluded.next_air_date, schedule_cache.next_air_date),
         imdb_score = excluded.imdb_score,
         modified_time = excluded.modified_time,
         last_synced = excluded.last_synced`
    ).bind(
      sanitizeD1Value(it.tmdb_id, 'tmdb_id'),
      sanitizeD1Value(it.tmdb_type, 'tmdb_type'),
      sanitizeD1Value(it.name, 'name') ?? '', // name NOT NULL trong schema -> fallback chuỗi rỗng thay vì null
      sanitizeD1Value(it.origin_name, 'origin_name'),
      sanitizeD1Value(it.poster_url, 'poster_url'),
      sanitizeD1Value(it.slug_kk, 'slug_kk'),
      sanitizeD1Value(it.slug_vs, 'slug_vs'),
      sanitizeD1Value(it.source_only, 'source_only'),
      sanitizeD1Value(it.next_air_date, 'next_air_date'),
      sanitizeD1Value(it.imdb_score, 'imdb_score'),
      sanitizeD1Value(it.modified_time, 'modified_time'),
      now
    ));
    try {
      await env.DB.batch(stmts);
      written += chunk.length;
    } catch (e) {
      // SỬA v29: trước đây nuốt lỗi hoàn toàn im lặng, không cách nào biết chunk nào/lỗi gì
      // khi debug qua Cloudflare Logs. Giờ log lại (không throw tiếp) để chunk khác vẫn ghi
      // tiếp bình thường, nhưng vẫn thấy được nguyên nhân nếu còn lỗi phát sinh sau này.
      console.log(`[schedule_cache] Lỗi ghi 1 chunk D1 (bỏ qua, chunk khác vẫn tiếp tục):`, String(e));
    }
  }

  return {
    total_merged: items.length,
    written,
    kk_count: kkRaw.length,
    vs_count: vsRaw.length + vsDangChieuRaw.length,
    next_air_date_lookups_this_run: lookups
  };
}

// ================= THÊM MỚI (v28): B2 (Backblaze) TRAILER STORAGE — thay Cloudinary =================
// Bucket B2 để Private (không cần thẻ tín dụng khi tạo, khác Public phải xác minh thanh toán) nên
// KHÔNG upload thẳng từ browser bằng unsigned preset như Cloudinary cũ được. Thay vào đó dùng
// "presigned URL" chuẩn AWS SigV4 (B2 tương thích S3 API): Worker tự ký 1 link PUT có hạn dùng
// ngắn, trả về cho control panel, browser PUT thẳng file lên B2 bằng link đó — Worker không phải
// nhận/giữ toàn bộ file video trong bộ nhớ (tránh vỡ giới hạn RAM của Worker với file lớn).
// Khi phát trailer, index.html gọi qua route GET /media/b2/<key> — Worker tự ký 1 link GET ngắn
// hạn để lấy file từ B2 rồi stream lại cho người xem, hỗ trợ Range (tua video) + cache biên
// (Cloudflare edge cache) giống hệt cơ chế proxySegment() đã có sẵn ở trên cho .ts segment.
// Không dùng SDK ngoài (giữ worker nhẹ, không cần bundler) — tự triển khai SigV4 bằng Web Crypto
// (subtle.digest/importKey/sign), vốn đã có sẵn trong runtime Cloudflare Workers.

async function b2HmacSha256(keyBytes, message) {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message)));
}

async function b2Sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function b2ToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function b2GetSigningKey(secretKey, dateStamp, region) {
  const kDate = await b2HmacSha256(new TextEncoder().encode('AWS4' + secretKey), dateStamp);
  const kRegion = await b2HmacSha256(kDate, region);
  const kService = await b2HmacSha256(kRegion, 's3');
  return b2HmacSha256(kService, 'aws4_request');
}

// Tạo presigned URL (query-string signing, chuẩn SigV4) cho B2 — dùng chung cho cả PUT (upload)
// lẫn GET (tải xuống để phát). `key` là đường dẫn file trong bucket, VD 'trailers/173-abcd.mp4'.
async function b2PresignUrl(env, { method, key, expiresSeconds = 600 }) {
  const endpoint = env.B2_ENDPOINT; // vd: s3.us-east-005.backblazeb2.com
  const bucket = env.B2_BUCKET;     // vd: ktuongfx-trailers
  const keyId = env.B2_KEY_ID;
  const appKey = env.B2_APP_KEY;
  if (!endpoint || !bucket || !keyId || !appKey) return null;

  const region = endpoint.split('.')[1] || 'us-east-005'; // s3.us-east-005.backblazeb2.com -> us-east-005

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260819T172400Z
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(queryParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`).join('&');

  const canonicalHeaders = `host:${endpoint}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const hashedCanonicalRequest = await b2Sha256Hex(canonicalRequest);
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, hashedCanonicalRequest].join('\n');

  const signingKey = await b2GetSigningKey(appKey, dateStamp, region);
  const signature = b2ToHex(await b2HmacSha256(signingKey, stringToSign));

  return `https://${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export default {
  async fetch(request, env, ctx) {
    const TMDB_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiI3MDUxYjI1NWMyNDMyZDBhOTgxZjE4MTlmMDYwYjViYSIsIm5iZiI6MTc4MzI2MzI4MC43NDMsInN1YiI6IjZhNGE3MDMwYzcyMjc1NGFiNzUyMWI3NiIsInNjb3BlcyI6WyJhcGlfcmVhZCJdLCJ2ZXJzaW9uIjoxfQ.4ARUeBsQbyRRBNOWR51f_swwzThKEgyIlZlcsIkb4x0";
    const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    function jsonResponse(data, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const cache = caches.default;

    // ---- Hash nội dung gốc (để phát hiện overview_en đổi -> cache cũ hết hạn) ----
    async function hashSourceText(text) {
      const data = new TextEncoder().encode(text || '');
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // ---- Lưu bản dịch thành công vào D1 (bảng episode_translations_v2) ----
    async function saveEpisodeTranslation({ tmdbId, seasonNumber, episodeNumber, sourceText, overviewVi }) {
      if (!env.DB || !tmdbId || !seasonNumber || !episodeNumber || !overviewVi) return;
      try {
        const sourceHash = await hashSourceText(sourceText);
        await env.DB.prepare(
          `INSERT INTO episode_translations_v2 (tmdb_id, season_number, episode_number, source_hash, overview_vi, translated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(tmdb_id, season_number, episode_number)
           DO UPDATE SET source_hash = excluded.source_hash, overview_vi = excluded.overview_vi, translated_at = excluded.translated_at`
        ).bind(tmdbId, seasonNumber, episodeNumber, sourceHash, overviewVi, new Date().toISOString()).run();
      } catch (e) {
        // Không chặn response chính nếu lưu D1 lỗi, chỉ bỏ qua
      }
    }

    // ---- Đọc lại các bản dịch đã lưu cho 1 season, đối chiếu hash để tránh trả cache lỗi thời ----
    async function getSeasonTranslations(tmdbId, seasonNumber) {
      if (!env.DB) return new Map();
      try {
        const { results } = await env.DB.prepare(
          'SELECT episode_number, source_hash, overview_vi FROM episode_translations_v2 WHERE tmdb_id = ? AND season_number = ?'
        ).bind(tmdbId, seasonNumber).all();
        const map = new Map();
        for (const row of results || []) map.set(row.episode_number, row);
        return map;
      } catch (e) {
        return new Map();
      }
    }

    // ---- Lưu bản dịch tiểu sử diễn viên vào D1 (bảng actor_bio_translations) ----
    // ĐÃ SỬA (v22): KHÔNG còn gọi ngầm qua ctx.waitUntil trong lúc dịch nữa — đồng bộ đúng pattern
    // đã có sẵn cho tập phim (/translate-groq): dịch xong trả kết quả ngay, KHÔNG ghi D1 kèm theo vì
    // làm chậm phản hồi và không cho frontend biết chắc đã lưu hay chưa. Hàm này giờ CHỈ được gọi từ
    // endpoint /save-actor-bio khi người dùng chủ động bấm nút "Lưu" — await thật, trả true/false
    // đúng kết quả ghi D1 để frontend báo cho người dùng.
    async function saveActorBioTranslation({ personId, sourceText, bioVi }) {
      if (!env.DB || !personId || !bioVi) return false;
      try {
        const sourceHash = await hashSourceText(sourceText);
        await env.DB.prepare(
          `INSERT INTO actor_bio_translations (tmdb_person_id, source_hash, bio_vi, translated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(tmdb_person_id)
           DO UPDATE SET source_hash = excluded.source_hash, bio_vi = excluded.bio_vi, translated_at = excluded.translated_at`
        ).bind(personId, sourceHash, bioVi, new Date().toISOString()).run();
        return true;
      } catch (e) {
        return false;
      }
    }

    // ---- THÊM MỚI: đọc lại bản dịch tiểu sử đã lưu, đối chiếu hash để tránh trả cache lỗi thời
    // (VD TMDB cập nhật lại tiểu sử tiếng Anh của diễn viên đó) ----
    async function getActorBioTranslation(personId, sourceText) {
      if (!env.DB || !personId) return null;
      try {
        const row = await env.DB.prepare(
          'SELECT source_hash, bio_vi FROM actor_bio_translations WHERE tmdb_person_id = ?'
        ).bind(personId).first();
        if (!row) return null;
        const sourceHash = await hashSourceText(sourceText);
        if (row.source_hash !== sourceHash) return null; // tiểu sử gốc đã đổi -> cache cũ, dịch lại
        return row.bio_vi;
      } catch (e) {
        return null;
      }
    }

    // ---- Proxy ẢNH ----
    async function proxyImage(originUrl, cacheTtlSeconds = 60 * 60 * 24 * 7) {
      const cacheKey = new Request(url.toString(), request);
      let cached = await cache.match(cacheKey);
      if (cached) return cached;

      const res = await fetch(originUrl, {
        cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true }
      });

      const headers = new Headers({
        'Content-Type': res.headers.get('Content-Type') || 'image/jpeg',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': `public, max-age=${cacheTtlSeconds}, immutable`,
      });
      const response = new Response(res.body, { status: res.status, headers });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }

    // ---- Proxy API JSON ----
    async function proxyJson(originUrl, freshTtlSeconds = 300, staleTtlSeconds = 3600, timeoutMs = 6000, extraHeaders = {}) {
      const cacheKey = new Request(url.toString(), request);
      const cached = await cache.match(cacheKey);

      async function fetchFromOrigin() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(originUrl, {
            headers: { 'Accept': 'application/json', ...extraHeaders },
            cf: { cacheTtl: 0 },
            signal: controller.signal
          });
          const body = await res.text();
          const response = new Response(body, {
            status: res.status,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': `public, max-age=${staleTtlSeconds}`,
              'X-Cached-At': String(Date.now()),
            }
          });
          if (res.ok) {
            await cache.put(cacheKey, response.clone());
          }
          return response;
        } finally {
          clearTimeout(timer);
        }
      }

      if (cached) {
        const cachedAt = Number(cached.headers.get('X-Cached-At') || 0);
        const ageSeconds = (Date.now() - cachedAt) / 1000;
        if (ageSeconds < freshTtlSeconds) return cached;

        ctx.waitUntil(fetchFromOrigin().catch(() => {}));
        return cached;
      }

      try {
        return await fetchFromOrigin();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'upstream_timeout_or_error', detail: String(e) }), {
          status: 504,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ================= TMDB =================
    if (url.pathname.startsWith('/tmdb/')) {
      const path = url.pathname.replace('/tmdb', '');
      const isSearchOrDiscover = path.includes('/search/') || path.includes('/discover/');
      const staleTtl = isSearchOrDiscover ? 300 : 86400;

      return proxyJson(`https://api.themoviedb.org/3${path}${url.search}`, 300, staleTtl, 6000, {
        'Authorization': `Bearer ${TMDB_TOKEN}`
      });
    }

    if (url.pathname.startsWith('/tmdbimg/')) {
      const path = url.pathname.replace('/tmdbimg', '');
      return proxyImage(`https://image.tmdb.org/t/p${path}`);
    }

    // ================= DỊCH CHỦ ĐỘNG BẰNG GROQ API (llama-3.3-70b-versatile) =================
    const GROQ_MODEL = 'openai/gpt-oss-120b'; // Đổi từ llama-3.3-70b-versatile (Groq deprecate model này từ 17/6/2026)
    const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
    const GROQ_SYSTEM_PROMPT_SINGLE = 'Bạn là biên dịch viên phim chuyên nghiệp. Hãy dịch đoạn tóm tắt tập phim sang tiếng Việt mượt mà, tự nhiên, đúng ngữ cảnh phim ảnh. Chỉ trả về duy nhất nội dung đã dịch, không kèm lời giải thích, không kèm dấu ngoặc kép bao ngoài, không thêm ký tự thừa.';

    if (url.pathname === '/translate-groq' && request.method === 'POST') {
      // API Key phải để trong Cloudflare Secret: wrangler secret put GROQ_API_KEY
      const GROQ_API_KEY = env.GROQ_API_KEY;
      if (!GROQ_API_KEY) return jsonResponse({ error: 'groq_key_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const { tmdb_id, season_number, episode_number, text } = body || {};
      if (!text || !text.trim()) return jsonResponse({ error: 'missing_text' }, 400);

      // Vì nút dịch mở cho mọi khách (không cần đăng nhập), chặn spam bằng rate limit theo IP
      if (env.RECOMMENDED_KV) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `translate_rl:${ip}`;
        const hits = parseInt(await env.RECOMMENDED_KV.get(rlKey) || '0', 10);
        if (hits >= 20) {
          return jsonResponse({ error: 'rate_limited', detail: 'Quá nhiều yêu cầu dịch, thử lại sau ít phút.' }, 429);
        }
        ctx.waitUntil(env.RECOMMENDED_KV.put(rlKey, String(hits + 1), { expirationTtl: 60 }));
      }

      try {
        const groqRes = await fetch(GROQ_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: GROQ_SYSTEM_PROMPT_SINGLE },
              { role: 'user', content: text }
            ],
            temperature: 0.3
          })
        });

        // Fallback an toàn: Groq bị rate limit (429) hoặc lỗi khác -> giữ nguyên tiếng Anh, không crash.
        if (groqRes.status === 429) {
          return jsonResponse({ success: true, overview_vi: text, fallback: true, error: 'rate_limited' }, 200);
        }
        if (!groqRes.ok) {
          return jsonResponse({ success: true, overview_vi: text, fallback: true, error: 'groq_api_error', status: groqRes.status }, 200);
        }

        const groqData = await groqRes.json();
        const overviewVi = groqData?.choices?.[0]?.message?.content?.trim();

        if (!overviewVi) {
          return jsonResponse({ success: true, overview_vi: text, fallback: true, error: 'groq_empty_response' }, 200);
        }

        // KHÔNG auto-save D1 ở đây nữa (theo yêu cầu — ghi D1 làm chậm phản hồi).
        // Frontend giữ kết quả dịch trong state, người dùng bấm nút "Lưu" sẽ gọi
        // POST /save-episode-translations để ghi xuống D1 khi cần.
        return jsonResponse({ success: true, overview_vi: overviewVi, fallback: false });
      } catch (e) {
        // Lỗi mạng/parse bất kỳ -> vẫn fallback giữ tiếng Anh thay vì trả lỗi cứng.
        return jsonResponse({ success: true, overview_vi: text, fallback: true, error: 'translation_failed', detail: String(e) }, 200);
      }
    }

    // ================= LƯU BẢN DỊCH TIỂU SỬ DIỄN VIÊN VÀO D1 (chủ động, do người dùng bấm "Lưu") =================
    // Tách riêng khỏi lúc dịch (/translate-actor-bio không còn tự lưu) — đúng pattern đã có sẵn cho
    // tập phim (/save-episode-translations): dịch trả kết quả ngay, lưu D1 là bước riêng do người
    // dùng chủ động bấm, await ghi D1 thật rồi mới trả kết quả để UI báo đúng thành công/thất bại.
    if (url.pathname === '/save-actor-bio' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const { person_id, text, bio_vi } = body || {};
      if (!person_id || !bio_vi) return jsonResponse({ success: false, error: 'missing_fields' }, 400);

      const saved = await saveActorBioTranslation({ personId: person_id, sourceText: text, bioVi: bio_vi });
      return jsonResponse({ success: saved }, saved ? 200 : 500);
    }

    // ================= THÊM MỚI: DỊCH TIỂU SỬ DIỄN VIÊN (Groq) — có cache D1 theo person_id =================
    // Khác /translate-groq (episode): kiểm tra D1 trước, có bản dịch khớp hash thì trả ngay,
    // không tốn lượt gọi Groq. Chỉ gọi Groq + tự động lưu D1 khi chưa có/hash đổi.
    const GROQ_SYSTEM_PROMPT_BIO = 'Bạn là biên dịch viên phim chuyên nghiệp. Hãy dịch đoạn tiểu sử diễn viên/đạo diễn sau sang tiếng Việt mượt mà, tự nhiên. Giữ nguyên tên riêng, tên phim, tên giải thưởng, địa danh (không dịch, không phiên âm). Chỉ trả về duy nhất nội dung đã dịch, không kèm lời giải thích, không kèm dấu ngoặc kép bao ngoài, không thêm ký tự thừa.';

    if (url.pathname === '/translate-actor-bio' && request.method === 'POST') {
      const GROQ_API_KEY = env.GROQ_API_KEY;
      if (!GROQ_API_KEY) return jsonResponse({ error: 'groq_key_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const { person_id, text, check_only } = body || {};
      if (!text || !text.trim()) return jsonResponse({ error: 'missing_text' }, 400);

      // Đã có bản dịch lưu sẵn (khớp hash với tiểu sử gốc hiện tại) -> trả ngay, khỏi gọi Groq.
      const cachedBioVi = await getActorBioTranslation(person_id, text);
      if (cachedBioVi) {
        return jsonResponse({ success: true, bio_vi: cachedBioVi, cached: true, fallback: false });
      }

      // THÊM MỚI (v23): check_only=true dùng để frontend tự kiểm tra cache D1 ngay khi vào trang
      // diễn viên (giống /episode-overview tự hiện bản dịch có sẵn, không cần bấm nút). Chỉ đọc D1
      // (rẻ, không tốn rate-limit/Groq) — nếu CHƯA có bản dịch thì dừng ở đây luôn, KHÔNG dịch thật,
      // để frontend biết cần hiện nút "Hiển thị thông tin diễn viên" cho người dùng chủ động bấm
      // (tránh tự động đốt quota Groq cho mọi lượt xem trang).
      if (check_only) {
        return jsonResponse({ success: true, cached: false, bio_vi: null });
      }

      // Dùng chung ngân sách rate-limit theo IP với /translate-groq (translate_rl) để tránh spam.
      if (env.RECOMMENDED_KV) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `translate_rl:${ip}`;
        const hits = parseInt(await env.RECOMMENDED_KV.get(rlKey) || '0', 10);
        if (hits >= 20) {
          return jsonResponse({ error: 'rate_limited', detail: 'Quá nhiều yêu cầu dịch, thử lại sau ít phút.' }, 429);
        }
        ctx.waitUntil(env.RECOMMENDED_KV.put(rlKey, String(hits + 1), { expirationTtl: 60 }));
      }

      try {
        const groqRes = await fetch(GROQ_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: GROQ_SYSTEM_PROMPT_BIO },
              { role: 'user', content: text }
            ],
            temperature: 0.3
          })
        });

        if (groqRes.status === 429) {
          return jsonResponse({ success: true, bio_vi: text, fallback: true, error: 'rate_limited' }, 200);
        }
        if (!groqRes.ok) {
          return jsonResponse({ success: true, bio_vi: text, fallback: true, error: 'groq_api_error', status: groqRes.status }, 200);
        }

        const groqData = await groqRes.json();
        const bioVi = groqData?.choices?.[0]?.message?.content?.trim();

        if (!bioVi) {
          return jsonResponse({ success: true, bio_vi: text, fallback: true, error: 'groq_empty_response' }, 200);
        }

        // ĐÃ SỬA (v22): bỏ auto-save ngầm (ctx.waitUntil) — đồng bộ đúng pattern đã có sẵn cho tập
        // phim (/translate-groq, xem comment "KHÔNG auto-save D1 ở đây nữa" ở trên): ghi D1 làm chậm
        // phản hồi, và auto-save ngầm không cho frontend biết chắc đã lưu thành công hay chưa.
        // Frontend giữ bio_vi trong state, người dùng bấm nút "Lưu" mới gọi POST /save-actor-bio để
        // ghi D1 (await thật, báo đúng kết quả).
        return jsonResponse({ success: true, bio_vi: bioVi, fallback: false });
      } catch (e) {
        return jsonResponse({ success: true, bio_vi: text, fallback: true, error: 'translation_failed', detail: String(e) }, 200);
      }
    }

    // ================= DỊCH HÀNG LOẠT (GOM TỐI ĐA 15 TẬP / 1 LƯỢT GỌI GROQ) =================
    const GROQ_BATCH_SIZE = 15;
    const GROQ_SYSTEM_PROMPT_BATCH = [
      'Bạn là biên dịch viên phim chuyên nghiệp.',
      'Bạn sẽ nhận vào một mảng JSON các tập phim, mỗi phần tử có dạng {"id": <số>, "text": "<tóm tắt tiếng Anh>"}.',
      'Nhiệm vụ: dịch trường "text" của TỪNG phần tử sang tiếng Việt mượt mà, tự nhiên, đúng ngữ cảnh phim ảnh.',
      'Yêu cầu output BẮT BUỘC: chỉ trả về một JSON object DUY NHẤT theo đúng cấu trúc:',
      '{"translations": [{"id": <số, giữ nguyên id gốc>, "overview_vi": "<bản dịch tiếng Việt>"}, ...]}',
      'Giữ nguyên số lượng phần tử và đúng "id" tương ứng với input, không thêm giải thích, không thêm text ngoài JSON.'
    ].join(' ');

    if (url.pathname === '/translate-groq-batch' && request.method === 'POST') {
      const GROQ_API_KEY = env.GROQ_API_KEY;
      if (!GROQ_API_KEY) return jsonResponse({ error: 'groq_key_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const { tmdb_id, season_number, episodes } = body || {};
      // episodes: [{ episode_number, text }, ...] — chỉ nên truyền các tập CHƯA dịch
      if (!tmdb_id || !season_number || !Array.isArray(episodes) || episodes.length === 0) {
        return jsonResponse({ error: 'invalid_payload' }, 400);
      }

      // 2. Lọc tập hợp lệ (có episode_number + text) rồi gom tối đa 15 tập/lượt gọi
      const validEpisodes = episodes
        .filter(ep => ep && ep.episode_number && (ep.text || '').trim())
        .slice(0, GROQ_BATCH_SIZE);

      if (validEpisodes.length === 0) {
        return jsonResponse({ error: 'no_valid_episodes' }, 400);
      }

      // Rate limit theo IP — 1 lượt batch tính là 1 lượt gọi thật sự tới Groq
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (env.RECOMMENDED_KV) {
        const rlKey = `translate_rl:${ip}`;
        const hits = parseInt(await env.RECOMMENDED_KV.get(rlKey) || '0', 10);
        if (hits >= 20) {
          return jsonResponse({ error: 'rate_limited', detail: 'Quá nhiều yêu cầu dịch, thử lại sau ít phút.' }, 429);
        }
        ctx.waitUntil(env.RECOMMENDED_KV.put(rlKey, String(hits + 1), { expirationTtl: 60 }));
      }

      // Map để tra lại text gốc theo episode_number khi cần fallback / lưu D1
      const sourceByEpisode = new Map(validEpisodes.map(ep => [ep.episode_number, (ep.text || '').trim()]));
      const inputPayload = validEpisodes.map(ep => ({ id: ep.episode_number, text: (ep.text || '').trim() }));

      // Hàm build kết quả fallback (giữ nguyên tiếng Anh) cho toàn bộ batch khi Groq lỗi/bị rate limit
      function buildFallbackResults(errorCode) {
        return validEpisodes.map(ep => ({
          episode_number: ep.episode_number,
          overview_vi: sourceByEpisode.get(ep.episode_number),
          fallback: true,
          error: errorCode
        }));
      }

      // 3. Gọi Groq API — 1 request duy nhất cho cả batch, ép response_format json_object
      let groqRes;
      try {
        groqRes = await fetch(GROQ_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`
          },
          body: JSON.stringify({
            model: GROQ_MODEL,
            messages: [
              { role: 'system', content: GROQ_SYSTEM_PROMPT_BATCH },
              { role: 'user', content: JSON.stringify(inputPayload) }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.3
          })
        });
      } catch (e) {
        // Lỗi mạng khi gọi Groq -> fallback toàn bộ batch về tiếng Anh, không crash app
        return jsonResponse({ success: true, results: buildFallbackResults('network_error'), fallback: true, detail: String(e) });
      }

      // Groq bị Rate Limit (429) -> fallback giữ nguyên tiếng Anh cho cả batch
      if (groqRes.status === 429) {
        return jsonResponse({ success: true, results: buildFallbackResults('rate_limited'), fallback: true });
      }
      if (!groqRes.ok) {
        return jsonResponse({ success: true, results: buildFallbackResults('groq_api_error'), fallback: true, status: groqRes.status });
      }

      // 4. Parse JSON trả về từ Groq và map lại vào từng tập theo "id" (episode_number)
      let translations;
      try {
        const groqData = await groqRes.json();
        const rawContent = groqData?.choices?.[0]?.message?.content;
        const parsed = JSON.parse(rawContent);
        translations = Array.isArray(parsed?.translations) ? parsed.translations : null;
        if (!translations) throw new Error('missing_translations_array');
      } catch (e) {
        // Groq trả JSON sai cấu trúc/không parse được -> fallback toàn bộ batch, không crash app
        return jsonResponse({ success: true, results: buildFallbackResults('groq_invalid_json'), fallback: true });
      }

      const translationById = new Map(
        translations
          .filter(t => t && t.id !== undefined && t.id !== null)
          .map(t => [Number(t.id), (t.overview_vi || '').trim()])
      );

      // 5. Map kết quả về từng tập; tập nào Groq không trả (thiếu id) thì fallback riêng tập đó
      const results = validEpisodes.map(ep => {
        const overviewVi = translationById.get(Number(ep.episode_number));
        const sourceText = sourceByEpisode.get(ep.episode_number);

        if (!overviewVi) {
          return { episode_number: ep.episode_number, overview_vi: sourceText, fallback: true, error: 'missing_in_groq_response' };
        }

        // KHÔNG auto-save D1 ở đây nữa (theo yêu cầu — ghi D1 làm chậm phản hồi khi dịch).
        // Frontend giữ kết quả trong state, người dùng bấm nút "Lưu" sẽ gọi
        // POST /save-episode-translations để ghi hàng loạt xuống D1 khi cần.
        return { episode_number: ep.episode_number, overview_vi: overviewVi, fallback: false };
      });

      return jsonResponse({ success: true, results });
    }

    // ================= LƯU BẢN DỊCH VÀO D1 (chủ động, do người dùng bấm nút "Lưu") =================
    // Tách riêng khỏi lúc dịch để nút Dịch trả kết quả ngay, không phải chờ ghi D1.
    // Frontend giữ kết quả dịch trong state (React/localStorage/...), khi người dùng bấm "Lưu"
    // mới gọi endpoint này để ghi hàng loạt xuống D1.
    if (url.pathname === '/save-episode-translations' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const { tmdb_id, season_number, episodes } = body || {};
      // episodes: [{ episode_number, source_text (tiếng Anh gốc), overview_vi (bản dịch) }, ...]
      if (!tmdb_id || !season_number || !Array.isArray(episodes) || episodes.length === 0) {
        return jsonResponse({ error: 'invalid_payload' }, 400);
      }

      const valid = episodes.filter(ep =>
        ep && ep.episode_number && (ep.overview_vi || '').trim() && (ep.source_text || '').trim()
      ).slice(0, 100); // chặn payload quá lớn trong 1 lượt lưu

      if (valid.length === 0) {
        return jsonResponse({ error: 'no_valid_episodes' }, 400);
      }

      // Ghi song song, nhưng bắt lỗi từng tập riêng để 1 tập lỗi không làm hỏng cả lượt lưu
      const saveResults = await Promise.all(valid.map(async ep => {
        try {
          await saveEpisodeTranslation({
            tmdbId: parseInt(tmdb_id, 10) || null,
            seasonNumber: parseInt(season_number, 10) || null,
            episodeNumber: parseInt(ep.episode_number, 10) || null,
            sourceText: ep.source_text,
            overviewVi: ep.overview_vi
          });
          return { episode_number: ep.episode_number, saved: true };
        } catch (e) {
          return { episode_number: ep.episode_number, saved: false, error: String(e) };
        }
      }));

      const savedCount = saveResults.filter(r => r.saved).length;
      return jsonResponse({ success: true, saved_count: savedCount, total: valid.length, results: saveResults });
    }

    // ================= EPISODE OVERVIEW (Lấy dữ liệu tập + trả về bản dịch từ D1 nếu có) =================
    if (url.pathname === '/episode-overview' && request.method === 'GET') {
      const tmdbId = parseInt(url.searchParams.get('tmdb_id') || '', 10);
      const seasonNumber = parseInt(url.searchParams.get('season') || '1', 10);
      if (!tmdbId) return jsonResponse({ error: 'missing_tmdb_id' }, 400);

      // Đọc lại bản dịch đã lưu trong D1 (bảng episode_translations_v2). Để tránh lặp lại bug cũ
      // (cache lưu nhầm bản fallback tiếng Anh như đã dịch xong), chỉ dùng bản dịch đã lưu nếu
      // hash của overview_en hiện tại khớp với source_hash lúc dịch — nếu TMDB đổi nội dung
      // overview_en, cache cũ tự động bị coi là hết hạn và nút Dịch sẽ hiện lại.

      // Lấy metadata các tập từ TMDB
      let tmdbRes, tmdbData;
      try {
        tmdbRes = await fetch(
          `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}?language=en-US`,
          { headers: { 'Authorization': `Bearer ${TMDB_TOKEN}`, 'Accept': 'application/json' } }
        );
        tmdbData = await tmdbRes.json();
      } catch (e) {
        return jsonResponse({ error: 'tmdb_fetch_failed', detail: String(e) }, 502);
      }
      if (!tmdbRes.ok || !Array.isArray(tmdbData?.episodes)) {
        return jsonResponse({ error: 'tmdb_invalid_response' }, 502);
      }

      // Lấy các bản dịch đã lưu cho season này, rồi đối chiếu hash với overview_en hiện tại
      const savedMap = await getSeasonTranslations(tmdbId, seasonNumber);
      const episodes = await Promise.all(tmdbData.episodes.map(async e => {
        const overviewEn = e.overview || '';
        let overviewVi = null;
        let overviewSource = 'none';

        const saved = savedMap.get(e.episode_number);
        if (saved && overviewEn) {
          const currentHash = await hashSourceText(overviewEn);
          if (currentHash === saved.source_hash) {
            overviewVi = saved.overview_vi;
            overviewSource = 'cache';
          }
        }

        return {
          episode_number: e.episode_number,
          name: e.name || `Episode ${e.episode_number}`,
          still_path: e.still_path || null,
          air_date: e.air_date || null,
          runtime: e.runtime || null,
          overview_en: overviewEn,
          overview_vi: overviewVi,
          overview_source: overviewSource
        };
      }));

      return jsonResponse({ success: true, tmdb_id: tmdbId, season: seasonNumber, episodes });
    }

    // ================= OPHIM (API + ẢNH) =================
    if (url.pathname.startsWith('/ophim/')) {
      const path = url.pathname.replace('/ophim', '');
      return proxyJson(`https://ophim1.com${path}${url.search}`, 300, 86400, 10000, {
        'User-Agent': BROWSER_USER_AGENT
      });
    }

    if (url.pathname.startsWith('/ophimimg/')) {
      const path = url.pathname.replace('/ophimimg', '');
      return proxyImage(`https://img.ophim.live${path}`);
    }

    // ================= KKPHIM (API + ẢNH) =================
    if (url.pathname.startsWith('/kkphim/')) {
      const path = url.pathname.replace('/kkphim', '');
      return proxyJson(`https://phimapi.com${path}${url.search}`, 300, 86400, 10000, {
        'User-Agent': BROWSER_USER_AGENT
      });
    }

    if (url.pathname.startsWith('/kkphimimg/')) {
      const path = url.pathname.replace('/kkphimimg', '');
      return proxyImage(`https://phimimg.com${path}`);
    }

    // ================= HLS STREAM PROXY =================
    // THÊM MỚI (v33): 'vsmov' để /hlsproxy proxy được luôn m3u8/segment của VSMOV (v8.streamvsmov.com,
    // p25.streamvsmov.com...) — bắt buộc vì hls.js gọi fetch/XHR cấp JS nên cần CORS đúng, khác với
    // <video src> HTML thường. Xem resolveVsmov() bên dưới.
    const ALLOWED_STREAM_HOST_KEYWORDS = ['ophim', 'kkphim', 'phimapi', 'phimimg', 'opstream', 'm3u8', 'cdn', 'hls', 'storage', 'video', 'vsmov'];
    function isAllowedStreamHost(hostname) {
      return ALLOWED_STREAM_HOST_KEYWORDS.some(kw => hostname.includes(kw));
    }

    async function proxyM3U8(targetUrl) {
      let target;
      try { target = new URL(targetUrl); } catch (e) {
        return new Response('Invalid url', { status: 400, headers: corsHeaders });
      }
      if (!isAllowedStreamHost(target.hostname)) {
        return new Response('Host not allowed', { status: 403, headers: corsHeaders });
      }

      const res = await fetch(target.toString(), {
        headers: { 'Referer': target.origin, 'Origin': target.origin }
      });
      if (!res.ok) {
        return new Response('Upstream error', { status: res.status, headers: corsHeaders });
      }
      const text = await res.text();
      const workerOrigin = url.origin;

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP')) {
          return line.replace(/URI="([^"]+)"/, (m, uri) => {
            const abs = new URL(uri, target).toString();
            return `URI="${workerOrigin}/hlsproxy/segment?url=${encodeURIComponent(abs)}"`;
          });
        }
        if (trimmed === '' || trimmed.startsWith('#')) return line;
        const abs = new URL(trimmed, target).toString();
        if (abs.includes('.m3u8')) {
          return `${workerOrigin}/hlsproxy/m3u8?url=${encodeURIComponent(abs)}`;
        }
        return `${workerOrigin}/hlsproxy/segment?url=${encodeURIComponent(abs)}`;
      }).join('\n');

      return new Response(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=5',
        }
      });
    }

    async function proxySegment(targetUrl) {
      let target;
      try { target = new URL(targetUrl); } catch (e) {
        return new Response('Invalid url', { status: 400, headers: corsHeaders });
      }
      if (!isAllowedStreamHost(target.hostname)) {
        return new Response('Host not allowed', { status: 403, headers: corsHeaders });
      }

      const cacheKey = new Request(target.toString(), { method: 'GET' });
      const rangeHeader = request.headers.get('Range');

      if (!rangeHeader) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('Access-Control-Allow-Origin', '*');
          return new Response(cached.body, { status: cached.status, headers });
        }
      }

      const res = await fetch(target.toString(), {
        headers: {
          'Referer': target.origin,
          'Origin': target.origin,
          ...(rangeHeader ? { 'Range': rangeHeader } : {})
        },
        cf: { cacheEverything: true, cacheTtl: 60 * 60 * 24 }
      });

      const headers = new Headers({
        'Content-Type': res.headers.get('Content-Type') || 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=86400, immutable',
        'Accept-Ranges': 'bytes',
      });
      if (res.headers.get('Content-Range')) headers.set('Content-Range', res.headers.get('Content-Range'));
      if (res.headers.get('Content-Length')) headers.set('Content-Length', res.headers.get('Content-Length'));

      const response = new Response(res.body, { status: res.status, headers });
      if (!rangeHeader) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    }

    if (url.pathname === '/hlsproxy/m3u8') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing url', { status: 400, headers: corsHeaders });
      return proxyM3U8(target);
    }

    if (url.pathname === '/hlsproxy/segment') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing url', { status: 400, headers: corsHeaders });
      return proxySegment(target);
    }

    // ================= VSMOV RESOLVER (v34) =================
    // Trang embed VSMOV (https://{v8|v14|...}.streamvsmov.com/video/{hash}) chỉ lộ ra qua <iframe>,
    // không có link_m3u8/subtitle sẵn trong API /api/phim/{slug} như KKPhim. Phải tự fetch HTML trang
    // embed, lấy videoHash từ link_embed (frontend cắt sẵn, truyền vào query ?hash=) rồi parse:
    //   - subtitles: mảng JSON hợp lệ nhúng thẳng trong <script> (const playerOptions = {...})
    //   - m3u8: công thức cố định `${baseUrl}/stream/${hash}/master.m3u8` khi enableSignedUrl=false
    //     (mặc định site hiện tại), fallback đọc signedMasterUrl nếu họ bật ký URL sau này.
    // SỬA (v34): VSMOV load-balance qua NHIỀU subdomain stream khác nhau (v8, v14, có thể còn nữa),
    // KHÔNG cố định 1 host — trước đây hardcode "v8.streamvsmov.com" nên mọi hash không thuộc v8 đều
    // resolve lỗi (embed_fetch_failed_404) dù hash hợp lệ. Giờ nhận thêm ?host= từ frontend (frontend
    // tự cắt từ chính link_embed của tập đó), CHỈ chấp nhận subdomain đúng dạng *.streamvsmov.com để
    // tránh bị lợi dụng làm proxy fetch tuỳ ý site khác (SSRF).
    // Cache theo CẢ host+hash trong RECOMMENDED_KV — vì cùng 1 hash về lý thuyết luôn gắn với đúng 1
    // host cố định (server nào giữ file đó), nhưng gộp cả 2 vào key cho chắc, tránh dính cache chéo
    // nếu sau này VSMOV đổi cơ chế cho phép hash trùng ở nhiều host.
    async function resolveVsmov(hash, host) {
      if (!hash || !/^[a-zA-Z0-9-]+$/.test(hash)) return { error: 'invalid_hash' };
      if (!host || !/^[a-zA-Z0-9-]+\.streamvsmov\.com$/.test(host)) return { error: 'invalid_host' };

      const kvKey = `vsmov_resolve:${host}:${hash}`;
      if (env.RECOMMENDED_KV) {
        const cached = await env.RECOMMENDED_KV.get(kvKey, 'json');
        if (cached) return cached;
      }

      const baseUrl = `https://${host}`;
      const embedUrl = `${baseUrl}/video/${hash}`;

      let html;
      try {
        const res = await fetch(embedUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT } });
        if (!res.ok) return { error: `embed_fetch_failed_${res.status}` };
        html = await res.text();
      } catch (e) {
        return { error: 'embed_fetch_exception', detail: String(e) };
      }

      // ---- Phụ đề: mảng JSON hợp lệ, không có [] lồng bên trong nên regex "không tham lam" tới
      // dấu ']' đầu tiên là đủ an toàn để cắt đúng ranh giới mảng. Lỗi parse (VSMOV đổi cấu trúc) ->
      // trả subtitles rỗng thay vì làm hỏng cả response (video vẫn phát được, chỉ mất phụ đề).
      const CODE_LABELS = { vie: 'Tiếng Việt', eng: 'English' };
      let subtitles = [];
      const subMatch = html.match(/subtitles:\s*(\[.*?\])/s);
      if (subMatch) {
        try {
          const rawSubs = JSON.parse(subMatch[1]);
          subtitles = rawSubs
            .map((s) => ({
              code: s.code || 'unk',
              label: CODE_LABELS[s.code] || (s.code ? s.code.toUpperCase() : 'Khác'),
              url: s.url ? (String(s.url).startsWith('http') ? s.url : baseUrl + s.url) : null
            }))
            .filter((s) => s.url);
        } catch (e) { /* bỏ qua, subtitles giữ nguyên [] */ }
      }

      // ---- m3u8: mặc định công thức cố định; chỉ đọc signedMasterUrl khi site bật enableSignedUrl.
      let m3u8Raw = `${baseUrl}/stream/${hash}/master.m3u8`;
      const signedFlagMatch = html.match(/enableSignedUrl:\s*(true|false)/);
      const signedUrlMatch = html.match(/signedMasterUrl:\s*"([^"]*)"/);
      if (signedFlagMatch && signedFlagMatch[1] === 'true' && signedUrlMatch && signedUrlMatch[1]) {
        m3u8Raw = signedUrlMatch[1];
      }
      // Bọc qua /hlsproxy/m3u8 sẵn có (bắt buộc, xem comment ALLOWED_STREAM_HOST_KEYWORDS ở trên).
      const m3u8 = `${url.origin}/hlsproxy/m3u8?url=${encodeURIComponent(m3u8Raw)}`;

      const result = { m3u8, subtitles };
      if (env.RECOMMENDED_KV) {
        ctx.waitUntil(env.RECOMMENDED_KV.put(kvKey, JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 30 }));
      }
      return result;
    }

    if (url.pathname === '/vsmov/resolve') {
      const hash = url.searchParams.get('hash');
      const host = url.searchParams.get('host');
      const result = await resolveVsmov(hash, host);
      if (result.error) return jsonResponse(result, result.error === 'invalid_hash' || result.error === 'invalid_host' ? 400 : 502);
      return jsonResponse(result);
    }

    // ================= GITHUB STORAGE =================
    const GITHUB_API = 'https://api.github.com';

    function githubConfigured() {
      return !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
    }

    async function githubRequest(path, options = {}) {
      return fetch(`${GITHUB_API}${path}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'ktuongfx-worker',
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      });
    }

    async function githubGetFile(filePath) {
      const branch = env.GITHUB_BRANCH || 'main';
      const res = await githubRequest(`/repos/${env.GITHUB_REPO}/contents/${encodeURI(filePath)}?ref=${branch}`);
      if (res.status === 404) return { content: null, sha: null };
      if (!res.ok) throw new Error(`github_get_failed_${res.status}`);
      const data = await res.json();
      const b64 = (data.content || '').replace(/\n/g, '');
      const decoded = decodeURIComponent(escape(atob(b64)));
      return { content: decoded, sha: data.sha };
    }

    async function githubPutFile(filePath, contentStr, message, sha = null, isBase64 = false) {
      const branch = env.GITHUB_BRANCH || 'main';
      const body = {
        message,
        branch,
        content: isBase64 ? contentStr : btoa(unescape(encodeURIComponent(contentStr)))
      };
      if (sha) body.sha = sha;
      const res = await githubRequest(`/repos/${env.GITHUB_REPO}/contents/${encodeURI(filePath)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`github_put_failed_${res.status}:${errText}`);
      }
      return res.json();
    }

    async function githubGetJson(filePath, fallback) {
      try {
        const { content } = await githubGetFile(filePath);
        return content ? JSON.parse(content) : fallback;
      } catch (e) {
        return fallback;
      }
    }

    function githubPublicUrl(filePath) {
      const branch = env.GITHUB_BRANCH || 'main';
      return `https://cdn.jsdelivr.net/gh/${env.GITHUB_REPO}@${branch}/${filePath}`;
    }

    if (url.pathname === '/admin/upload-image' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!githubConfigured()) return jsonResponse({ error: 'github_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const dataBase64 = (body?.dataBase64 || '').toString();
      const folder = ['posts', 'avatar', 'row-logos', 'freeze'].includes(body?.folder) ? body.folder : 'posts';
      let ext = (body?.filename || '').toString().split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) ext = 'jpg';

      if (!dataBase64) return jsonResponse({ error: 'missing_data' }, 400);
      if (dataBase64.length > 7000000) return jsonResponse({ error: 'file_too_large' }, 413);

      const filePath = `uploads/${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      try {
        await githubPutFile(filePath, dataBase64, `upload: ${filePath}`, null, true);
        return jsonResponse({ success: true, url: githubPublicUrl(filePath), path: filePath });
      } catch (e) {
        return jsonResponse({ error: 'github_upload_failed', detail: String(e) }, 500);
      }
    }

    if (url.pathname === '/admin/upload-video' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!githubConfigured()) return jsonResponse({ error: 'github_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const dataBase64 = (body?.dataBase64 || '').toString();
      const folder = ['trailers'].includes(body?.folder) ? body.folder : 'trailers';
      let ext = (body?.filename || '').toString().split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['mp4', 'webm'].includes(ext)) ext = 'mp4';

      if (!dataBase64) return jsonResponse({ error: 'missing_data' }, 400);
      if (dataBase64.length > 27000000) return jsonResponse({ error: 'file_too_large' }, 413);

      const filePath = `uploads/${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
      try {
        await githubPutFile(filePath, dataBase64, `upload trailer: ${filePath}`, null, true);
        return jsonResponse({ success: true, url: githubPublicUrl(filePath), path: filePath });
      } catch (e) {
        return jsonResponse({ error: 'github_upload_failed', detail: String(e) }, 500);
      }
    }

    // ================= THÊM MỚI (v38): SUB ADMIN — lưu vào D1 file phụ đề (.vtt) admin tự upload
    // cho từng tập, khi sub tự động (KKPhim/NguonC/VSMOV) bị sai/lệch không sửa được bằng offset.
    // SỬA: việc upload lên Cloudinary diễn ra THẲNG từ trình duyệt admin (unsigned upload preset,
    // xem AppHandlers.adminPickSubtitleFile trong app.js — cùng cơ chế với upload trailer/ảnh bài
    // viết trong control-panel-v33.html, KHÔNG qua Worker). Worker ở đây chỉ nhận URL Cloudinary đã
    // có sẵn rồi lưu vào D1 theo movie_slug + ep_idx — không cần biết CLOUDINARY_API_KEY/SECRET gì cả.
    if (url.pathname === '/admin/upload-subtitle' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const subUrl = (body?.url || '').toString().trim().slice(0, 500);
      const movieSlug = (body?.movie_slug || '').toString().trim().slice(0, 200);
      const epIdxRaw = parseInt(body?.ep_idx, 10);
      const epIdx = Number.isFinite(epIdxRaw) ? epIdxRaw : null;
      const epName = (body?.ep_name || '').toString().slice(0, 100);
      // SỬA (v25): trước đây bỏ sót hoàn toàn field lang_label — frontend (app.js) đã gửi đúng tên sub
      // admin tự đặt trong body, nhưng Worker không đọc/không lưu, nên GET lại luôn ra rỗng và frontend
      // fallback về nhãn mặc định "Sub Admin". Đồng thời ON CONFLICT(movie_slug, ep_idx) cũ (không có
      // lang_label) khiến mỗi tập chỉ lưu được DUY NHẤT 1 sub admin — upload sub thứ 2 (tên khác) sẽ
      // ghi đè mất sub đầu, dù frontend đã thiết kế cho phép nhiều sub/tập (v39, Vietsub + English...).
      const langLabel = (body?.lang_label || 'Vietsub').toString().trim().slice(0, 40) || 'Vietsub';

      if (!subUrl) return jsonResponse({ error: 'missing_url' }, 400);
      if (!movieSlug || epIdx === null) return jsonResponse({ error: 'missing_episode_ref' }, 400);

      try {
        // SỬA (v25): UNIQUE key đổi thành (movie_slug, ep_idx, lang_label) — cần migrate D1 (xem ghi
        // chú migration bên dưới cuối file) để bảng thật sự có cột lang_label + unique index mới,
        // nếu không câu INSERT này sẽ lỗi "no such column: lang_label" hoặc constraint cũ vẫn áp dụng.
        await env.DB.prepare(
          `INSERT INTO custom_subtitles (movie_slug, ep_idx, ep_name, lang_label, url, uploaded_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(movie_slug, ep_idx, lang_label)
           DO UPDATE SET ep_name = excluded.ep_name, url = excluded.url, uploaded_at = excluded.uploaded_at`
        ).bind(movieSlug, epIdx, epName, langLabel, subUrl, new Date().toISOString()).run();
        return jsonResponse({ success: true, url: subUrl, lang_label: langLabel });
      } catch (e) {
        return jsonResponse({ error: 'db_save_failed', detail: String(e) }, 500);
      }
    }

    // Admin xoá sub đã upload cho 1 tập (quay về dùng sub gốc/tắt sub).
    if (url.pathname === '/admin/upload-subtitle' && request.method === 'DELETE') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const movieSlug = (url.searchParams.get('movie_slug') || '').trim().slice(0, 200);
      const epIdxRaw = parseInt(url.searchParams.get('ep_idx'), 10);
      const epIdx = Number.isFinite(epIdxRaw) ? epIdxRaw : null;
      // SỬA (v25): frontend (adminRemoveCustomSubtitle) đã gửi kèm lang_label để xoá ĐÚNG 1 sub trong
      // nhiều sub/tập — trước đây Worker bỏ qua param này, DELETE theo (movie_slug, ep_idx) sẽ xoá
      // NHẦM/xoá HẾT dòng của tập đó thay vì chỉ 1 sub được chọn.
      const langLabel = (url.searchParams.get('lang_label') || '').trim().slice(0, 40);
      if (!movieSlug || epIdx === null) return jsonResponse({ error: 'missing_episode_ref' }, 400);
      try {
        if (langLabel) {
          await env.DB.prepare('DELETE FROM custom_subtitles WHERE movie_slug = ? AND ep_idx = ? AND lang_label = ?').bind(movieSlug, epIdx, langLabel).run();
        } else {
          // Không truyền lang_label (client cũ) -> giữ hành vi cũ, xoá hết sub admin của tập này.
          await env.DB.prepare('DELETE FROM custom_subtitles WHERE movie_slug = ? AND ep_idx = ?').bind(movieSlug, epIdx).run();
        }
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: 'delete_failed', detail: String(e) }, 500);
      }
    }

    // Đọc công khai (không cần đăng nhập) toàn bộ sub admin đã upload cho 1 phim — frontend gọi
    // khi vào trang xem để biết tập nào có sub riêng, gắn thêm vào menu CC bên cạnh sub gốc.
    if (url.pathname === '/custom-subtitles' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ items: [] });
      const movieSlug = (url.searchParams.get('movie_slug') || '').trim().slice(0, 200);
      if (!movieSlug) return jsonResponse({ items: [] });
      try {
        // SỬA (v25): thêm lang_label vào SELECT — trước đây thiếu cột này nên entry.lang_label ở
        // frontend luôn undefined, hiển thị nhầm nhãn mặc định "Sub Admin" thay vì tên admin đã đặt.
        const { results } = await env.DB.prepare(
          'SELECT ep_idx, ep_name, lang_label, url FROM custom_subtitles WHERE movie_slug = ?'
        ).bind(movieSlug).all();
        return jsonResponse({ items: results || [] });
      } catch (e) {
        return jsonResponse({ items: [] });
      }
    }

    async function checkAdminAuth() {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return false;
      const valid = await env.RECOMMENDED_KV.get(`session:${token}`);
      return valid === '1';
    }

    if (url.pathname === '/login' && request.method === 'POST') {
      if (!env.ADMIN_PASSWORD) return jsonResponse({ error: 'server_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      if (!body?.password || body.password !== env.ADMIN_PASSWORD) {
        return jsonResponse({ error: 'wrong_password' }, 401);
      }

      const token = crypto.randomUUID();
      await env.RECOMMENDED_KV.put(`session:${token}`, '1', { expirationTtl: 60 * 60 * 12 });
      return jsonResponse({ token });
    }

    // ================= THÊM MỚI (v28): B2 TRAILER STORAGE — 2 route thay cho Cloudinary =================
    // 1) /admin/media/presign-upload — control panel gọi trước khi upload, xin 1 link PUT đã ký
    //    (hạn 15 phút), rồi browser PUT thẳng file video lên B2 bằng link đó, KHÔNG đi qua Worker.
    if (url.pathname === '/admin/media/presign-upload' && request.method === 'POST') {
      if (!(await checkAdminAuth())) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_ENDPOINT || !env.B2_BUCKET) {
        // THÊM MỚI (v29): trả kèm tên biến nào đang thiếu để debug trên mobile không cần devtools
        const missing = [
          !env.B2_KEY_ID && 'B2_KEY_ID',
          !env.B2_APP_KEY && 'B2_APP_KEY',
          !env.B2_ENDPOINT && 'B2_ENDPOINT',
          !env.B2_BUCKET && 'B2_BUCKET',
        ].filter(Boolean).join(', ');
        return jsonResponse({ error: 'b2_not_configured', missing }, 500);
      }

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }

      const rawName = (body?.filename || 'trailer.mp4').toString();
      const extMatch = rawName.toLowerCase().match(/\.(mp4|webm)$/);
      const safeExt = extMatch ? extMatch[0] : '.mp4'; // chỉ nhận mp4/webm, khớp accept của input file phía control panel
      const key = `trailers/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${safeExt}`;

      const uploadUrl = await b2PresignUrl(env, { method: 'PUT', key, expiresSeconds: 900 });
      if (!uploadUrl) return jsonResponse({ error: 'b2_not_configured' }, 500);

      // publicUrl = link phát video qua chính Worker này (route bên dưới), KHÔNG phải link B2 trực
      // tiếp — vì bucket Private, link B2 trần sẽ báo lỗi 403 nếu không có chữ ký kèm theo.
      const publicUrl = `${url.origin}/media/b2/${key}`;
      return jsonResponse({ uploadUrl, key, publicUrl });
    }

    // 2) /media/b2/<key> — phát trailer cho người xem. Worker tự ký 1 link GET ngắn hạn (5 phút,
    //    chỉ Worker dùng nội bộ, người xem không bao giờ thấy link này) để lấy file từ B2, hỗ trợ
    //    Range (tua video) + cache biên Cloudflare giống hệt proxySegment() ở trên cho .ts segment.
    if (url.pathname.startsWith('/media/b2/') && request.method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice('/media/b2/'.length));
      if (!key) return new Response('Missing key', { status: 400, headers: corsHeaders });
      if (!env.B2_KEY_ID || !env.B2_APP_KEY || !env.B2_ENDPOINT || !env.B2_BUCKET) {
        // THÊM MỚI (v29): trả kèm tên biến nào đang thiếu để debug trên mobile không cần devtools
        const missing = [
          !env.B2_KEY_ID && 'B2_KEY_ID',
          !env.B2_APP_KEY && 'B2_APP_KEY',
          !env.B2_ENDPOINT && 'B2_ENDPOINT',
          !env.B2_BUCKET && 'B2_BUCKET',
        ].filter(Boolean).join(', ');
        return new Response(`B2 not configured (missing: ${missing})`, { status: 500, headers: corsHeaders });
      }

      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const rangeHeader = request.headers.get('Range');

      // Không tua (không có Range) -> thử lấy từ cache biên trước, đỡ phải ký + gọi B2 lại từ đầu.
      if (!rangeHeader) {
        const cached = await cache.match(cacheKey);
        if (cached) {
          const headers = new Headers(cached.headers);
          headers.set('Access-Control-Allow-Origin', '*');
          return new Response(cached.body, { status: cached.status, headers });
        }
      }

      const signedUrl = await b2PresignUrl(env, { method: 'GET', key, expiresSeconds: 300 });
      if (!signedUrl) return new Response('B2 not configured', { status: 500, headers: corsHeaders });

      const res = await fetch(signedUrl, { headers: rangeHeader ? { 'Range': rangeHeader } : {} });
      if (!res.ok && res.status !== 206) {
        return new Response('Không tải được trailer từ B2', { status: res.status, headers: corsHeaders });
      }

      const headers = new Headers({
        'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
        // Trailer không đổi nội dung sau khi upload (key có timestamp riêng mỗi lần) -> cache dài hạn an toàn.
        'Cache-Control': 'public, max-age=604800, immutable',
        'Accept-Ranges': 'bytes',
      });
      if (res.headers.get('Content-Range')) headers.set('Content-Range', res.headers.get('Content-Range'));
      if (res.headers.get('Content-Length')) headers.set('Content-Length', res.headers.get('Content-Length'));

      const response = new Response(res.body, { status: res.status, headers });
      // Chỉ cache bản KHÔNG Range (bản đầy đủ) — cache bản Range sẽ trả nhầm đoạn cho request khác.
      if (!rangeHeader && res.ok) {
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
      }
      return response;
    }

    // ================= THÊM MỚI: LỊCH CHIẾU — trigger tay để test trước khi chờ cron 6h =================
    // Bảo vệ bằng checkAdminAuth() có sẵn (cùng token admin dùng cho các route quản trị khác).
    if (url.pathname === '/admin/sync-schedule' && request.method === 'POST') {
      if (!(await checkAdminAuth())) return jsonResponse({ error: 'unauthorized' }, 401);
      const result = await syncScheduleCache(env);
      return jsonResponse(result);
    }

    // ================= SỬA v31: LỊCH CHIẾU — endpoint đọc, PUBLIC (không cần admin auth) =================
    // Frontend gọi GET /api/lich-chieu?offset=0..6 (0=hôm nay, 1=ngày mai... 6=6 ngày sau, theo
    // giờ VN) để lấy danh sách phim CÓ TẬP MỚI ĐÚNG ngày đó — dựa trên next_air_date thật lấy từ
    // TMDB (next_episode_to_air), không phải weekday suy đoán từ pattern quá khứ như trước (xem
    // getNextAirDate() ở trên). Không có 'offset' -> mặc định hôm nay.
    // Giữ tên param cũ 'day' làm alias tương thích ngược cho FE chưa kịp đổi, xử lý giống offset.
    if (url.pathname === '/api/lich-chieu' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);

      let offset = parseInt(url.searchParams.get('offset') ?? url.searchParams.get('day'), 10);
      if (!Number.isInteger(offset) || offset < 0 || offset > 6) offset = 0;

      // Tính ngày cụ thể (YYYY-MM-DD) theo giờ Việt Nam (UTC+7), server-side, không phụ thuộc
      // giờ máy người dùng — cộng thêm offset ngày.
      const nowVN = new Date(Date.now() + 7 * 60 * 60 * 1000 + offset * 86400000);
      const targetDate = nowVN.toISOString().slice(0, 10); // 'YYYY-MM-DD'

      try {
        const { results } = await env.DB.prepare(
          `SELECT tmdb_id, tmdb_type, name, origin_name, poster_url, slug_kk, slug_vs,
                  source_only, next_air_date, imdb_score, age_rating, is_vip, modified_time
           FROM schedule_cache
           WHERE next_air_date = ?
           ORDER BY imdb_score DESC, name ASC
           LIMIT 100`
        ).bind(targetDate).all();

        // Ưu tiên trả slug_kk để mở phim (nguồn chính của site) theo đúng convention hiện có
        // của các chỗ khác trong code (KKPhim ưu tiên qua tryAutoUpgradeToKK) — chỉ dùng slug_vs
        // làm fallback khi phim chỉ có trên VSMOV.
        const items = (results || []).map(r => ({
          tmdb_id: r.tmdb_id,
          tmdb_type: r.tmdb_type,
          name: r.name,
          origin_name: r.origin_name,
          poster_url: r.poster_url,
          slug: r.slug_kk || r.slug_vs || null,
          // THÊM MỚI: trả rõ 'provider' khớp với slug đang trả (KK hay VS) để frontend gọi thẳng
          // AppHandlers.goToWatch(slug, provider) không cần tự suy luận lại từ source_only.
          provider: r.slug_kk ? 'KK' : (r.slug_vs ? 'VS' : null),
          source: r.source_only,
          imdb_score: r.imdb_score,
          age_rating: r.age_rating,
          is_vip: !!r.is_vip
        })).filter(it => it.slug); // phim không có slug nào thì không mở được -> loại khỏi kết quả

        return jsonResponse({ offset, date: targetDate, count: items.length, items });
      } catch (e) {
        return jsonResponse({ error: 'query_failed', detail: String(e) }, 500);
      }
    }

    // ================= TÀI KHOẢN & LỊCH SỬ XEM PHIM =================
    const PBKDF2_ITERATIONS = 100000;

    function bytesToHex(bytes) {
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function hexToBytes(hex) {
      const arr = new Uint8Array(hex.length / 2);
      for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
      return arr;
    }
    async function hashPassword(password, saltHex = null) {
      const enc = new TextEncoder();
      const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
      const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial, 256
      );
      return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
    }
    async function verifyPassword(password, saltHex, expectedHashHex) {
      const { hash } = await hashPassword(password, saltHex);
      return hash === expectedHashHex;
    }

    function isValidUsername(u) {
      return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u);
    }

    async function checkUserAuth() {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) return null;
      const userId = await env.RECOMMENDED_KV.get(`user_session:${token}`);
      return userId ? parseInt(userId, 10) : null;
    }

    if (url.pathname === '/register' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const username = (body?.username || '').toString().trim();
      const password = (body?.password || '').toString();

      if (!isValidUsername(username)) {
        return jsonResponse({ error: 'invalid_username', detail: 'Username 3-20 ký tự, chỉ gồm chữ/số/gạch dưới' }, 400);
      }
      if (password.length < 6) {
        return jsonResponse({ error: 'invalid_password', detail: 'Mật khẩu tối thiểu 6 ký tự' }, 400);
      }

      const existed = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
      if (existed) return jsonResponse({ error: 'username_taken' }, 409);

      const { hash, salt } = await hashPassword(password);
      let result;
      try {
        result = await env.DB.prepare(
          'INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'
        ).bind(username, hash, salt, Date.now()).run();
      } catch (e) {
        return jsonResponse({ error: 'username_taken' }, 409);
      }

      const userId = result.meta.last_row_id;
      const token = crypto.randomUUID();
      await env.RECOMMENDED_KV.put(`user_session:${token}`, String(userId), { expirationTtl: 60 * 60 * 24 * 30 });
      return jsonResponse({ success: true, token, username, display_name: '', avatar_url: '' });
    }

    if (url.pathname === '/login-user' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const username = (body?.username || '').toString().trim();
      const password = (body?.password || '').toString();
      if (!username || !password) return jsonResponse({ error: 'missing_credentials' }, 400);

      const user = await env.DB.prepare('SELECT id, password_hash, salt, display_name, avatar_url FROM users WHERE username = ?').bind(username).first();
      if (!user) return jsonResponse({ error: 'wrong_credentials' }, 401);

      const ok = await verifyPassword(password, user.salt, user.password_hash);
      if (!ok) return jsonResponse({ error: 'wrong_credentials' }, 401);

      const token = crypto.randomUUID();
      await env.RECOMMENDED_KV.put(`user_session:${token}`, String(user.id), { expirationTtl: 60 * 60 * 24 * 30 });
      return jsonResponse({ success: true, token, username, display_name: user.display_name || '', avatar_url: user.avatar_url || '' });
    }

    if (url.pathname === '/user/profile' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      const user = await env.DB.prepare('SELECT username, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();
      if (!user) return jsonResponse({ error: 'not_found' }, 404);
      return jsonResponse({ username: user.username, display_name: user.display_name || '', avatar_url: user.avatar_url || '' });
    }

    if (url.pathname === '/user/profile' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const displayName = (body?.display_name || '').toString().trim().slice(0, 50);
      const avatarUrl = (body?.avatar_url || '').toString().trim().slice(0, 500);

      await env.DB.prepare('UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?')
        .bind(displayName, avatarUrl, userId).run();
      return jsonResponse({ success: true, display_name: displayName, avatar_url: avatarUrl });
    }

    if (url.pathname === '/user/upload-avatar' && request.method === 'POST') {
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!githubConfigured()) return jsonResponse({ error: 'github_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const dataBase64 = (body?.dataBase64 || '').toString();
      let ext = (body?.filename || '').toString().split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) ext = 'jpg';

      if (!dataBase64) return jsonResponse({ error: 'missing_data' }, 400);
      if (dataBase64.length > 4000000) return jsonResponse({ error: 'file_too_large' }, 413);

      const filePath = `uploads/user-avatars/${userId}-${Date.now()}.${ext}`;
      try {
        await githubPutFile(filePath, dataBase64, `upload avatar user ${userId}`, null, true);
        return jsonResponse({ success: true, url: githubPublicUrl(filePath) });
      } catch (e) {
        return jsonResponse({ error: 'github_upload_failed', detail: String(e) }, 500);
      }
    }

    if (url.pathname === '/history' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      const { results } = await env.DB.prepare(
        'SELECT movie_slug, movie_name, poster_url, source_provider, "current_time", last_ep_idx, last_ep_name, updated_at FROM watch_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50'
      ).bind(userId).all();
      return jsonResponse({ items: results || [] });
    }

    if (url.pathname === '/history' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const movieSlug = (body?.movie_slug || '').toString().trim().slice(0, 200);
      if (!movieSlug) return jsonResponse({ error: 'missing_movie_slug' }, 400);

      const movieName = (body?.movie_name || '').toString().slice(0, 200);
      const posterUrl = (body?.poster_url || '').toString().slice(0, 500);
      const sourceProvider = (body?.source_provider || '').toString().slice(0, 20);
      const currentTime = Number.isFinite(parseFloat(body?.current_time)) ? parseFloat(body.current_time) : 0;
      const epIdx = Number.isFinite(parseInt(body?.ep_idx, 10)) ? parseInt(body.ep_idx, 10) : 0;
      const epName = (body?.ep_name || '').toString().slice(0, 100);

      await env.DB.prepare(`
        INSERT INTO watch_history (user_id, movie_slug, movie_name, poster_url, source_provider, current_time, last_ep_idx, last_ep_name, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, movie_slug) DO UPDATE SET
          movie_name = excluded.movie_name,
          poster_url = excluded.poster_url,
          source_provider = excluded.source_provider,
          current_time = excluded.current_time,
          last_ep_idx = excluded.last_ep_idx,
          last_ep_name = excluded.last_ep_name,
          updated_at = excluded.updated_at
      `).bind(userId, movieSlug, movieName, posterUrl, sourceProvider, currentTime, epIdx, epName, Date.now()).run();

      return jsonResponse({ success: true });
    }

    if (url.pathname === '/history' && request.method === 'DELETE') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
      const slug = (url.searchParams.get('movie_slug') || '').trim();
      if (slug) await env.DB.prepare('DELETE FROM watch_history WHERE user_id = ? AND movie_slug = ?').bind(userId, slug).run();
      else await env.DB.prepare('DELETE FROM watch_history WHERE user_id = ?').bind(userId).run();
      return jsonResponse({ success: true });
    }

    // ================= FAVORITES =================
    if (url.pathname === '/favorites' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
      const { results } = await env.DB.prepare(
        'SELECT movie_slug, movie_name, poster_url, source_provider, added_at FROM favorites WHERE user_id = ? ORDER BY added_at DESC'
      ).bind(userId).all();
      return jsonResponse({ items: results || [] });
    }

    if (url.pathname === '/favorites/toggle' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const movieSlug = (body?.movie_slug || '').toString().trim().slice(0, 200);
      if (!movieSlug) return jsonResponse({ error: 'missing_movie_slug' }, 400);

      const existed = await env.DB.prepare('SELECT id FROM favorites WHERE user_id = ? AND movie_slug = ?').bind(userId, movieSlug).first();
      if (existed) {
        await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND movie_slug = ?').bind(userId, movieSlug).run();
        return jsonResponse({ success: true, is_favorite: false });
      }
      const movieName = (body?.movie_name || '').toString().slice(0, 200);
      const posterUrl = (body?.poster_url || '').toString().slice(0, 500);
      const sourceProvider = (body?.source_provider || '').toString().slice(0, 20);
      await env.DB.prepare(
        'INSERT INTO favorites (user_id, movie_slug, movie_name, poster_url, source_provider, added_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(userId, movieSlug, movieName, posterUrl, sourceProvider, Date.now()).run();
      return jsonResponse({ success: true, is_favorite: true });
    }

    if (url.pathname === '/favorites' && request.method === 'DELETE') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);
      const slug = (url.searchParams.get('movie_slug') || '').trim();
      if (slug) await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND movie_slug = ?').bind(userId, slug).run();
      else await env.DB.prepare('DELETE FROM favorites WHERE user_id = ?').bind(userId).run();
      return jsonResponse({ success: true });
    }

    // ================= COMMENTS =================
    if (url.pathname === '/comments' && request.method === 'GET') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const slug = (url.searchParams.get('slug') || '').trim();
      if (!slug) return jsonResponse({ error: 'missing_slug' }, 400);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;

      const totalRow = await env.DB.prepare(
        'SELECT COUNT(*) as c FROM comments WHERE movie_slug = ? AND parent_id IS NULL AND is_hidden = 0'
      ).bind(slug).first();

      const { results: topRows } = await env.DB.prepare(`
        SELECT c.id, c.content, c.is_spoiler, c.is_pinned, c.likes_count, c.dislikes_count, c.created_at, c.user_id, u.username, u.display_name, u.avatar_url
        FROM comments c JOIN users u ON c.user_id = u.id
        WHERE c.movie_slug = ? AND c.parent_id IS NULL AND c.is_hidden = 0
        ORDER BY c.is_pinned DESC, c.created_at DESC LIMIT 20 OFFSET ?
      `).bind(slug, offset).all();

      let replyRows = [];
      if (topRows.length) {
        const ids = topRows.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');
        const r = await env.DB.prepare(`
          SELECT c.id, c.content, c.is_spoiler, c.likes_count, c.dislikes_count, c.created_at, c.parent_id, c.user_id, u.username, u.display_name, u.avatar_url
          FROM comments c JOIN users u ON c.user_id = u.id
          WHERE c.parent_id IN (${placeholders}) AND c.is_hidden = 0
          ORDER BY c.created_at ASC
        `).bind(...ids).all();
        replyRows = r.results || [];
      }

      const comments = topRows.map(t => ({
        id: t.id, content: t.content, is_spoiler: !!t.is_spoiler, is_pinned: !!t.is_pinned,
        likes: t.likes_count || 0, dislikes: t.dislikes_count || 0, created_at: t.created_at,
        username: t.username, display_name: t.display_name, avatar_url: t.avatar_url,
        replies: replyRows.filter(r => r.parent_id === t.id).map(r => ({
          id: r.id, content: r.content, is_spoiler: !!r.is_spoiler,
          likes: r.likes_count || 0, dislikes: r.dislikes_count || 0, created_at: r.created_at,
          username: r.username, display_name: r.display_name, avatar_url: r.avatar_url
        }))
      }));

      return jsonResponse({ total: totalRow?.c || 0, offset, comments });
    }

    if (url.pathname === '/comments' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const movieSlug = (body?.movie_slug || '').toString().trim().slice(0, 200);
      const content = (body?.content || '').toString().trim().slice(0, 1000);
      const parentId = body?.parent_id ? parseInt(body.parent_id, 10) : null;
      const isSpoiler = body?.is_spoiler ? 1 : 0;

      if (!movieSlug) return jsonResponse({ error: 'missing_movie_slug' }, 400);
      if (!content) return jsonResponse({ error: 'missing_content' }, 400);

      const recentRow = await env.DB.prepare(
        'SELECT created_at FROM comments WHERE user_id = ? ORDER BY created_at DESC LIMIT 1'
      ).bind(userId).first();
      if (recentRow && Date.now() - recentRow.created_at < 8000) {
        return jsonResponse({ error: 'too_fast' }, 429);
      }

      const result = await env.DB.prepare(
        'INSERT INTO comments (movie_slug, user_id, content, parent_id, is_spoiler, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(movieSlug, userId, content, parentId, isSpoiler, Date.now()).run();

      const user = await env.DB.prepare('SELECT username, display_name, avatar_url FROM users WHERE id = ?').bind(userId).first();

      return jsonResponse({
        success: true,
        comment: {
          id: result.meta.last_row_id, content, is_spoiler: !!isSpoiler, is_pinned: false, likes: 0, dislikes: 0, created_at: Date.now(),
          parent_id: parentId, user_id: userId, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url
        }
      });
    }

    if (url.pathname === '/comments' && request.method === 'DELETE') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      const id = parseInt(url.searchParams.get('id') || '', 10);
      if (!id) return jsonResponse({ error: 'missing_id' }, 400);

      const comment = await env.DB.prepare('SELECT id, user_id, parent_id FROM comments WHERE id = ?').bind(id).first();
      if (!comment) return jsonResponse({ error: 'not_found' }, 404);
      if (comment.user_id !== userId) return jsonResponse({ error: 'forbidden' }, 403);

      if (comment.parent_id === null) {
        await env.DB.prepare('DELETE FROM comments WHERE parent_id = ?').bind(id).run();
      }
      await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();

      return jsonResponse({ success: true });
    }

    if (url.pathname === '/comments/pin' && request.method === 'PATCH') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const id = parseInt(body?.id, 10);
      if (!id) return jsonResponse({ error: 'missing_id' }, 400);
      const isPinned = body?.is_pinned ? 1 : 0;

      await env.DB.prepare('UPDATE comments SET is_pinned = ? WHERE id = ?').bind(isPinned, id).run();
      return jsonResponse({ success: true, id, is_pinned: !!isPinned });
    }

    if (url.pathname === '/comments/vote' && request.method === 'POST') {
      if (!env.DB) return jsonResponse({ error: 'db_not_configured' }, 500);
      const userId = await checkUserAuth();
      if (!userId) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const commentId = parseInt(body?.id, 10);
      const requestedType = ['like', 'dislike', 'none'].includes(body?.type) ? body.type : null;
      if (!commentId || !requestedType) return jsonResponse({ error: 'invalid_input' }, 400);

      const existing = await env.DB.prepare(
        'SELECT vote_type FROM comment_votes WHERE comment_id = ? AND user_id = ?'
      ).bind(commentId, userId).first();
      const existingType = existing?.vote_type || null;

      if (existingType === requestedType || (!existingType && requestedType === 'none')) {
        const row = await env.DB.prepare('SELECT likes_count, dislikes_count FROM comments WHERE id = ?').bind(commentId).first();
        return jsonResponse({ success: true, likes: row?.likes_count || 0, dislikes: row?.dislikes_count || 0 });
      }

      if (existingType === 'like') await env.DB.prepare('UPDATE comments SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').bind(commentId).run();
      if (existingType === 'dislike') await env.DB.prepare('UPDATE comments SET dislikes_count = MAX(0, dislikes_count - 1) WHERE id = ?').bind(commentId).run();
      if (requestedType === 'like') await env.DB.prepare('UPDATE comments SET likes_count = likes_count + 1 WHERE id = ?').bind(commentId).run();
      if (requestedType === 'dislike') await env.DB.prepare('UPDATE comments SET dislikes_count = dislikes_count + 1 WHERE id = ?').bind(commentId).run();

      if (requestedType === 'none') {
        await env.DB.prepare('DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?').bind(commentId, userId).run();
      } else {
        await env.DB.prepare(
          'INSERT INTO comment_votes (comment_id, user_id, vote_type, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(comment_id, user_id) DO UPDATE SET vote_type = excluded.vote_type, updated_at = excluded.updated_at'
        ).bind(commentId, userId, requestedType, Date.now()).run();
      }

      const row = await env.DB.prepare('SELECT likes_count, dislikes_count FROM comments WHERE id = ?').bind(commentId).first();
      return jsonResponse({ success: true, likes: row?.likes_count || 0, dislikes: row?.dislikes_count || 0 });
    }

    // ================= RECOMMENDATIONS & SETTINGS =================
    if (url.pathname === '/recommended' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('recommended_list');
      return jsonResponse({ items: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/recommended' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];
      const trimmed = items.slice(0, 50);
      await env.RECOMMENDED_KV.put('recommended_list', JSON.stringify(trimmed));
      return jsonResponse({ success: true, count: trimmed.length });
    }

    if (url.pathname === '/hero-override' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('hero_override_list');
      return jsonResponse({ items: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/hero-override' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];
      await env.RECOMMENDED_KV.put('hero_override_list', JSON.stringify(items));
      return jsonResponse({ success: true, count: items.length });
    }

    // THÊM MỚI: danh sách "Phim Song Ngữ" do admin tự tay xác nhận (thay vì suy đoán tự động
    // từ field `lang` của KKPhim — không đáng tin vì vsmov hên xui không phải phim nào cũng có
    // bản song ngữ thật). Mỗi item nên có {slug, sourceProvider, name, poster_url, thumb_url}
    // để trang chủ dựng card ngay mà không cần tra lại API.
    // CẬP NHẬT: giờ KV lưu CẢ OBJECT {items, position, afterRowIndex} thay vì chỉ mảng items —
    // vì section này có 1 vị trí hiển thị CHUNG cho cả danh sách (giống Playlist tuỳ chỉnh), khác
    // Hero Banner vốn luôn cố định ở đầu trang. Đọc dữ liệu cũ (nếu KV còn lưu dạng mảng thô từ
    // trước khi có field position) vẫn an toàn nhờ nhánh Array.isArray() bên dưới.
    if (url.pathname === '/bilingual-override' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('bilingual_override_list');
      if (!data) return jsonResponse({ items: [], position: 'top', afterRowIndex: 1 });
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        // Dữ liệu cũ (trước khi thêm position/afterRowIndex) — vẫn chỉ là mảng items thô.
        return jsonResponse({ items: parsed, position: 'top', afterRowIndex: 1 });
      }
      return jsonResponse({
        items: Array.isArray(parsed.items) ? parsed.items : [],
        position: parsed.position || 'top',
        afterRowIndex: parsed.afterRowIndex || 1,
      });
    }

    if (url.pathname === '/bilingual-override' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];
      const position = ['top', 'after_recommended', 'middle_rows', 'bottom'].includes(body?.position) ? body.position : 'top';
      const afterRowIndex = Number(body?.afterRowIndex) || 1;
      await env.RECOMMENDED_KV.put('bilingual_override_list', JSON.stringify({ items, position, afterRowIndex }));
      return jsonResponse({ success: true, count: items.length });
    }


    // ================= BADGE PHIM SONG NGỮ TỰ ĐỘNG (sub rời VSMOV) — v35 =================
    // Mục đích: thay vì admin dò tay từng phim xem VSMOV có sub rời (song ngữ) hay không,
    // route này quét THEO TRANG danh sách "phim mới cập nhật" của VSMOV (mới -> cũ, đúng thứ tự
    // trả về sẵn từ API), với mỗi phim: lấy chi tiết phim (/api/phim/{slug}) -> lấy link_embed
    // của server_data đầu tiên -> cắt host+hash -> gọi lại resolveVsmov() đã có sẵn ở trên ->
    // nếu subtitles có track code === 'vie' (phải có sub Việt rời, không chỉ cần có sub bất kỳ
    // ngôn ngữ nào) thì TỰ ĐỘNG gắn vào danh sách `bilingual_auto_list` — khác với
    // bilingual_override_list (danh sách admin tự chọn thủ công ở trên), đây là badge tự động
    // hiển thị trên MỌI poster của phim đó (trang chủ, tìm kiếm, thể loại...) chứ không phải 1
    // section riêng cố định vị trí. Admin vẫn xem được list này trong control panel để GỠ nếu
    // phát hiện gắn nhầm (VD sub lỗi, không thực sự song ngữ) — xem route DELETE bên dưới.
    // Chạy theo TRANG (mỗi trang ~24-30 phim của VSMOV), không quét hết catalog trong 1 lần vì
    // dễ vượt giới hạn CPU time của Worker và dễ bị VSMOV chặn rate nếu gọi dồn dập — admin bấm
    // nút "Quét trang tiếp theo" trong control panel, cursor trang tự lưu ở KV nên lần bấm sau
    // tiếp tục đúng chỗ đã dừng, không quét trùng lại từ đầu.
    function extractVsmovEmbed(detail) {
      const episodes = detail?.movie ? detail.episodes : null;
      const firstServer = episodes?.[0]?.server_data?.[0];
      const linkEmbed = firstServer?.link_embed || '';
      const m = String(linkEmbed).match(/^https?:\/\/([a-zA-Z0-9-]+\.streamvsmov\.com)\/video\/([a-zA-Z0-9-]+)/);
      if (!m) return null;
      return { host: m[1], hash: m[2] };
    }

    async function fetchVsmovDetail(slug) {
      try {
        const res = await fetch(`https://vsmov.com/api/phim/${encodeURIComponent(slug)}`, {
          headers: { 'User-Agent': BROWSER_USER_AGENT }
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data?.status || !data?.movie) return null;
        return data;
      } catch (e) { return null; }
    }

    if (url.pathname === '/admin/bilingual-scan' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { body = {}; }

      // Trang bắt đầu: ưu tiên page admin truyền lên (bấm lại 1 trang cụ thể để test); nếu không
      // truyền thì đọc cursor đã lưu, mặc định trang 1 nếu chưa quét lần nào.
      let page = Number(body?.page);
      if (!page || page < 1) {
        const savedCursor = await env.RECOMMENDED_KV.get('bilingual_scan_cursor');
        page = savedCursor ? (Number(savedCursor) || 1) : 1;
      }

      const listData = await fetchJsonSafe(`https://vsmov.com/api/danh-sach/phim-moi-cap-nhat?page=${page}`);
      const items = listData?.items || listData?.data?.items || [];
      if (!items.length) {
        return jsonResponse({ page, scanned: 0, newlyBadged: [], noMoreData: true });
      }

      const existingRaw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      const existingSlugs = new Set(existing.map(c => c.slug));

      const newlyBadged = [];
      // Chạy tuần tự (không Promise.all dồn hết) để tránh gọi VSMOV quá dồn dập trong 1 lúc.
      for (const item of items) {
        const slug = item?.slug;
        if (!slug || existingSlugs.has(slug)) continue;
        const detail = await fetchVsmovDetail(slug);
        const embed = extractVsmovEmbed(detail);
        if (!embed) continue;
        const resolved = await resolveVsmov(embed.hash, embed.host);
        // Bắt buộc có track code 'vie' — chỉ có sub (bất kỳ ngôn ngữ nào) là chưa đủ để coi là
        // "song ngữ" (VD chỉ có sub Anh thì không giúp gì cho phim vốn không có bản Việt).
        const hasVieSub = resolved?.subtitles?.some(s => s.code === 'vie');
        if (hasVieSub) {
          const badged = {
            slug,
            sourceProvider: 'vsmov',
            name: detail.movie.name || item.name || '',
            poster_url: detail.movie.poster_url || item.poster_url || null,
            thumb_url: detail.movie.thumb_url || item.thumb_url || null,
            subtitleLangs: resolved.subtitles.map(s => s.code),
            // THÊM MỚI: tmdb_id — chìa khoá chung giữa KKPhim/OPhim/VSMOV cho cùng 1 phim (mỗi
            // nguồn có slug riêng khác nhau, chỉ tmdb_id là khớp được xuyên nguồn). Không phải
            // phim nào VSMOV cũng có tmdb_id (thỉnh thoảng thiếu) -> giữ null, frontend tự bỏ qua
            // match theo tmdb_id cho case đó (badge chỉ hiện được khi render đúng bằng card VSMOV).
            tmdbId: detail.movie?.tmdb?.id ? String(detail.movie.tmdb.id) : null,
            foundAt: new Date().toISOString()
          };
          newlyBadged.push(badged);
          existingSlugs.add(slug);
        }
      }

      if (newlyBadged.length > 0) {
        const merged = [...existing, ...newlyBadged];
        await env.RECOMMENDED_KV.put('bilingual_auto_list', JSON.stringify(merged));
      }
      await env.RECOMMENDED_KV.put('bilingual_scan_cursor', String(page + 1));

      return jsonResponse({ page, scanned: items.length, newlyBadged, nextPage: page + 1 });
    }

    // Danh sách phim đang được gắn badge tự động — public, NHẸ để frontend gọi 1 lần lúc load
    // trang rồi tự kiểm tra khi dựng từng poster, không cần sửa các API danh sách phim hiện có
    // (KKPhim/OPhim) để nhét thêm field badge vào từng item.
    // SỬA: trả thêm `tmdbIds` (bên cạnh `slugs` cũ) — vì trang chủ/tìm kiếm thường render card
    // bằng dữ liệu KKPhim/OPhim, slug KHÁC hẳn slug VSMOV mà route quét ở trên dùng để lưu, nên so
    // theo slug sẽ KHÔNG khớp được. tmdb_id là field chung có ở cả 3 nguồn -> so theo tmdb_id mới
    // đúng bất kể card đang render bằng nguồn nào. Giữ `slugs` lại để không phá phần nào đang dùng nó.
    if (url.pathname === '/bilingual-slugs' && request.method === 'GET') {
      const raw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
      const items = raw ? JSON.parse(raw) : [];
      const tmdbIds = [...new Set(items.filter(i => i.tmdbId).map(i => i.tmdbId))];
      return jsonResponse({ slugs: items.map(i => i.slug), tmdbIds });
    }

    // ================= BADGE SONG NGỮ — CHECK NHANH THEO YÊU CẦU (v36) =================
    // Bổ sung cho cơ chế quét nền (/admin/bilingual-scan chạy theo cron): route đó đi 1 CHIỀU
    // (duyệt danh sách VSMOV -> tra tmdb_id -> lưu), nên phim MỚI ra mà cron chưa kịp quét tới sẽ
    // chưa có badge dù thực tế VSMOV đã có sub. Route này đi CHIỀU NGƯỢC LẠI: nhận 1 lô phim đang
    // hiện trên UI (search/trang chủ) kèm tên -> chủ động search sang VSMOV theo tên -> khớp đúng
    // bằng tmdb.id -> tra sub -> nếu có 'vie' thì gắn badge NGAY, không cần đợi cron.
    // Public (không cần checkAdminAuth) vì gọi từ mọi client đang search — nhưng có 2 lớp chặn lạm
    // dụng: (1) giới hạn tối đa 20 phim/request, (2) cache NEGATIVE (bilingual_checked_negative) để
    // phim đã tra mà không có sub thì không bị tra lại mỗi lần có người search trùng từ khoá, tránh
    // dội request vô ích sang VSMOV.
    if (url.pathname === '/bilingual-check-batch' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const requested = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
      if (!requested.length) return jsonResponse({ newlyBadged: [], checkedCount: 0 });

      const existingRaw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      const existingTmdbIds = new Set(existing.filter(i => i.tmdbId).map(i => String(i.tmdbId)));
      const existingSlugs = new Set(existing.map(i => i.slug));

      const negativeRaw = await env.RECOMMENDED_KV.get('bilingual_checked_negative');
      const negative = negativeRaw ? JSON.parse(negativeRaw) : {}; // { tmdbId: checkedAtISOString }
      const NEGATIVE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 ngày — sau đó cho tra lại phòng VSMOV bổ sung sub

      const newlyBadged = [];
      const newNegatives = [];
      let checkedCount = 0;

      // Tuần tự (không Promise.all) — cùng lý do với /admin/bilingual-scan: tránh gọi VSMOV dồn dập
      // trong 1 request, dễ bị họ chặn rate hoặc vượt CPU time giới hạn của Worker.
      for (const it of requested) {
        const tmdbId = it?.tmdbId ? String(it.tmdbId) : null;
        const name = (it?.name || '').toString().trim();
        if (!tmdbId || !name) continue;
        if (existingTmdbIds.has(tmdbId)) continue; // đã có badge rồi

        const lastChecked = negative[tmdbId];
        if (lastChecked && (Date.now() - new Date(lastChecked).getTime()) < NEGATIVE_TTL_MS) continue; // tra gần đây rồi, không thấy sub

        checkedCount++;
        let foundSlug = null;
        let foundName = name;
        let foundPoster = null;
        let foundThumb = null;
        try {
          const searchData = await fetchJsonSafe(`https://vsmov.com/api/tim-kiem?keyword=${encodeURIComponent(name)}`);
          const candidates = searchData?.items || searchData?.data?.items || [];
          const match = candidates.find(c => c?.tmdb?.id && String(c.tmdb.id) === tmdbId);
          if (match?.slug && !existingSlugs.has(match.slug)) {
            foundSlug = match.slug;
            foundName = match.name || name;
            foundPoster = match.poster_url || null;
            foundThumb = match.thumb_url || null;
          }
        } catch (e) { /* bỏ qua, coi như không tìm thấy */ }

        if (!foundSlug) { newNegatives.push(tmdbId); continue; }

        const detail = await fetchVsmovDetail(foundSlug);
        const embed = extractVsmovEmbed(detail);
        if (!embed) { newNegatives.push(tmdbId); continue; }

        const resolved = await resolveVsmov(embed.hash, embed.host);
        const hasVieSub = resolved?.subtitles?.some(s => s.code === 'vie');
        if (!hasVieSub) { newNegatives.push(tmdbId); continue; }

        const badged = {
          slug: foundSlug,
          sourceProvider: 'vsmov',
          name: detail?.movie?.name || foundName,
          poster_url: detail?.movie?.poster_url || foundPoster,
          thumb_url: detail?.movie?.thumb_url || foundThumb,
          subtitleLangs: resolved.subtitles.map(s => s.code),
          tmdbId,
          foundAt: new Date().toISOString(),
          foundVia: 'on-demand'
        };
        newlyBadged.push(badged);
        existingTmdbIds.add(tmdbId);
        existingSlugs.add(foundSlug);
      }

      if (newlyBadged.length > 0) {
        const merged = [...existing, ...newlyBadged];
        await env.RECOMMENDED_KV.put('bilingual_auto_list', JSON.stringify(merged));
      }
      if (newNegatives.length > 0) {
        const nowIso = new Date().toISOString();
        for (const id of newNegatives) negative[id] = nowIso;
        await env.RECOMMENDED_KV.put('bilingual_checked_negative', JSON.stringify(negative));
      }

      return jsonResponse({
        newlyBadged,
        checkedCount,
        tmdbIds: newlyBadged.map(b => b.tmdbId)
      });
    }

    // Xem đầy đủ danh sách đã gắn badge tự động (kèm tên/poster) để admin duyệt lại trong control
    // panel, và gỡ badge nếu phát hiện gắn nhầm.
    if (url.pathname === '/admin/bilingual-auto-list' && request.method === 'GET') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      const raw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
      const cursor = await env.RECOMMENDED_KV.get('bilingual_scan_cursor');
      return jsonResponse({ items: raw ? JSON.parse(raw) : [], nextPage: cursor ? Number(cursor) : 1 });
    }

    // Gỡ badge của 1 phim theo slug (admin xác nhận gắn nhầm).
    if (url.pathname === '/admin/bilingual-auto-list' && request.method === 'DELETE') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const slug = (body?.slug || '').toString();
      if (!slug) return jsonResponse({ error: 'missing_slug' }, 400);

      const raw = await env.RECOMMENDED_KV.get('bilingual_auto_list');
      const items = raw ? JSON.parse(raw) : [];
      const idx = items.findIndex(i => i.slug === slug);
      if (idx === -1) return jsonResponse({ error: 'not_found' }, 404);
      items.splice(idx, 1);
      await env.RECOMMENDED_KV.put('bilingual_auto_list', JSON.stringify(items));
      return jsonResponse({ success: true, slug });
    }

    // ================= POSTS =================
    const POSTS_PATH = 'data/posts.json';

    if (url.pathname === '/posts' && request.method === 'GET') {
      if (!githubConfigured()) return jsonResponse({ items: [] });
      const items = await githubGetJson(POSTS_PATH, []);
      return jsonResponse({ items });
    }

    if (url.pathname === '/posts' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!githubConfigured()) return jsonResponse({ error: 'github_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];

      const trimmed = items.slice(0, 100).map(p => ({
        id: (p?.id ? String(p.id) : crypto.randomUUID()).slice(0, 80),
        content: (p?.content || '').toString().slice(0, 5000),
        images: Array.isArray(p?.images) ? p.images.slice(0, 6).map(u => String(u).slice(0, 500)) : [],
        created_at: p?.created_at || new Date().toISOString()
      }));

      try {
        const { sha } = await githubGetFile(POSTS_PATH);
        await githubPutFile(POSTS_PATH, JSON.stringify(trimmed, null, 2), 'cập nhật bài viết', sha);
        return jsonResponse({ success: true, count: trimmed.length });
      } catch (e) {
        return jsonResponse({ error: 'github_save_failed', detail: String(e) }, 500);
      }
    }

    if (url.pathname === '/homepage-rows' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('homepage_rows_config');
      return jsonResponse({ rows: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/homepage-rows' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const rows = Array.isArray(body?.rows) ? body.rows : [];

      const trimmed = rows.slice(0, 30).map(r => ({
        title: (r?.title || '').toString().trim().slice(0, 60) || 'Mục phim',
        type: ['the-loai', 'quoc-gia', 'danh-sach'].includes(r?.type) ? r.type : 'danh-sach',
        slug: (r?.slug || '').toString().trim().slice(0, 60),
        limit: Math.min(Math.max(parseInt(r?.limit) || 12, 4), 24),
        rank: !!r?.rank,
        popularity: !!r?.popularity,
        hidden: !!r?.hidden,
        // SỬA LỖI: thiếu field "layout" ở đây khiến control panel gửi đúng nhưng bị lọc mất trước khi
        // lưu vào KV — sau khi refresh luôn thấy về mặc định "dọc" dù đã chọn "ngang". Nay giữ lại field
        // này (chỉ nhận đúng 2 giá trị hợp lệ, còn lại rơi về 'vertical' cho an toàn).
        layout: r?.layout === 'horizontal' ? 'horizontal' : 'vertical',
        logo: (() => {
          const v = (r?.logo || '').toString().trim().slice(0, 500);
          return /^https?:\/\//i.test(v) ? v : '';
        })(),
        excludedSlugs: Array.isArray(r?.excludedSlugs) ? r.excludedSlugs.map(s => (s || '').toString().slice(0, 200)).slice(0, 200) : []
      })).filter(r => r.slug);
      await env.RECOMMENDED_KV.put('homepage_rows_config', JSON.stringify(trimmed));
      return jsonResponse({ success: true, count: trimmed.length });
    }

    if (url.pathname === '/custom-rows' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('custom_rows');
      return jsonResponse({ rows: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/custom-rows' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const rows = Array.isArray(body?.rows) ? body.rows : [];

      const trimmed = rows.slice(0, 15).map(r => ({
        id: (r?.id ? String(r.id) : crypto.randomUUID()).slice(0, 80),
        title: (r?.title || 'Dòng phim mới').toString().trim().slice(0, 60) || 'Dòng phim mới',
        items: Array.isArray(r?.items) ? r.items.slice(0, 30) : [],
        position: ['top', 'after_recommended', 'middle_rows', 'bottom'].includes(r?.position) ? r.position : 'top',
        afterRowIndex: Math.min(Math.max(parseInt(r?.afterRowIndex) || 1, 1), 50),
        hidden: !!r?.hidden,
        logo: (() => {
          const v = (r?.logo || '').toString().trim().slice(0, 500);
          return /^https?:\/\//i.test(v) ? v : '';
        })(),
        // THÊM MỚI (v24): bố cục poster của dòng — 'vertical' (dọc, mặc định, giữ nguyên hành vi cũ)
        // hoặc 'horizontal' (ngang) — admin chọn trong control panel, index đọc field này để quyết
        // định render Render.movieCard theo hướng nào.
        layout: r?.layout === 'horizontal' ? 'horizontal' : 'vertical'
      }));
      await env.RECOMMENDED_KV.put('custom_rows', JSON.stringify(trimmed));
      return jsonResponse({ success: true, count: trimmed.length });
    }

    if (url.pathname === '/actors' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('favorite_actors');
      return jsonResponse({ items: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/actors' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];

      const trimmed = items.slice(0, 40).map(a => ({
        id: (a?.id ? String(a.id) : crypto.randomUUID()).slice(0, 80),
        tmdbId: Number.isFinite(parseInt(a?.tmdbId)) ? parseInt(a.tmdbId) : null,
        name: (a?.name || '').toString().trim().slice(0, 100),
        photo: (a?.photo || '').toString().trim().slice(0, 500),
        bio: (a?.bio || '').toString().trim().slice(0, 1000),
        position: ['top', 'after_recommended', 'middle_rows', 'bottom'].includes(a?.position) ? a.position : 'top',
        afterRowIndex: Math.min(Math.max(parseInt(a?.afterRowIndex) || 1, 1), 50)
      })).filter(a => a.name);

      await env.RECOMMENDED_KV.put('favorite_actors', JSON.stringify(trimmed));
      return jsonResponse({ success: true, count: trimmed.length });
    }

    // THÊM MỚI: Ghi đè TMDB ID theo slug — dùng khi chính KKPhim gắn sai tmdb.id cho phim
    // (VD phim nhiều phần nhưng 2 phần khác nhau lại cùng trỏ 1 tmdb.id -> overview/ảnh sai).
    // Admin tự tra đúng TMDB ID rồi lưu qua control panel, frontend (TMDB.resolveMatch) sẽ
    // ưu tiên dùng override này trước khi tin tmdb.id có sẵn từ KKPhim.
    if (url.pathname === '/tmdb-override' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('tmdb_override_list');
      return jsonResponse({ items: data ? JSON.parse(data) : [] });
    }

    if (url.pathname === '/tmdb-override' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const items = Array.isArray(body?.items) ? body.items : [];

      const trimmed = items.slice(0, 200).map(o => {
        const mediaType = o?.media_type === 'tv' ? 'tv' : 'movie';
        // THÊM MỚI: giữ lại season ghi đè (chỉ có ý nghĩa với phim bộ) — trước đây field này
        // bị loại bỏ khi lưu, khiến control panel nhập season xong lưu lại vẫn mất, frontend
        // không bao giờ nhận được season ghi đè -> vẫn tự dò season theo số tập như cũ.
        const seasonRaw = parseInt(o?.season, 10);
        const season = (mediaType === 'tv' && Number.isFinite(seasonRaw) && seasonRaw > 0) ? seasonRaw : null;
        return {
          slug: (o?.slug || '').toString().trim().slice(0, 200),
          tmdb_id: Number.isFinite(parseInt(o?.tmdb_id)) ? parseInt(o.tmdb_id) : null,
          media_type: mediaType,
          season
        };
      }).filter(o => o.slug && o.tmdb_id);

      await env.RECOMMENDED_KV.put('tmdb_override_list', JSON.stringify(trimmed));
      return jsonResponse({ success: true, count: trimmed.length });
    }

    if (url.pathname === '/maintenance' && request.method === 'GET') {
      const data = await env.RECOMMENDED_KV.get('maintenance_mode');
      return jsonResponse(data ? JSON.parse(data) : { enabled: false, image: '', text: '' });
    }

    if (url.pathname === '/maintenance' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const data = {
        enabled: !!body?.enabled,
        image: (body?.image || '').toString().trim().slice(0, 500),
        text: (body?.text || '').toString().trim().slice(0, 1000)
      };

      await env.RECOMMENDED_KV.put('maintenance_mode', JSON.stringify(data));
      return jsonResponse({ success: true, ...data });
    }

    const PROFILE_PATH = 'data/profile.json';

    if (url.pathname === '/admin/profile' && request.method === 'GET') {
      if (!githubConfigured()) return jsonResponse({ name: 'KTuongFX', avatar: '' });
      const profile = await githubGetJson(PROFILE_PATH, { name: 'KTuongFX', avatar: '' });
      return jsonResponse({ name: profile.name || 'KTuongFX', avatar: profile.avatar || '' });
    }

    if (url.pathname === '/admin/profile' && request.method === 'POST') {
      const isAdmin = await checkAdminAuth();
      if (!isAdmin) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!githubConfigured()) return jsonResponse({ error: 'github_not_configured' }, 500);

      let body;
      try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'invalid_json' }, 400); }
      const name = (body?.name || '').toString().trim().slice(0, 50) || 'KTuongFX';
      const avatar = (body?.avatar || '').toString().trim().slice(0, 500);

      try {
        const { sha } = await githubGetFile(PROFILE_PATH);
        await githubPutFile(PROFILE_PATH, JSON.stringify({ name, avatar }, null, 2), 'cập nhật hồ sơ admin', sha);
        return jsonResponse({ success: true, name, avatar });
      } catch (e) {
        return jsonResponse({ error: 'github_save_failed', detail: String(e) }, 500);
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // ================= THÊM MỚI: LỊCH CHIẾU — cron trigger, cấu hình lịch chạy trong wrangler.toml =================
  // SỬA (v36): đổi cron pattern thành mỗi 20 PHÚT (thay vì 6h cố định như trước) để phục vụ badge
  // song ngữ tự động quét nhanh phủ catalog trong ngày đầu (xem giải thích dưới). Cron 20 phút giờ
  // là "tick nền" DUY NHẤT cho cả 2 việc (lịch chiếu + quét bilingual) — tick nào không cần chạy
  // việc gì thì tự bỏ qua (return sớm, gần như không tốn CPU time), KHÔNG cần khai thêm cron pattern
  // thứ 2. Sửa lại wrangler.toml:
  //   [triggers]
  //   crons = ["*/20 * * * *"]
  //
  // Cơ chế tự throttle quét bilingual (KHÔNG cần sửa code/deploy lại sau ngày đầu):
  //   - Lần đầu tiên worker thấy KV chưa có `bilingual_scan_started_at` -> ghi mốc thời điểm NGAY
  //     LÚC ĐÓ (coi như "ngày đầu tiên" bắt đầu từ đây, KHÔNG phải từ lúc deploy code — vì lần
  //     deploy và lần cron đầu tiên chạy thật có thể lệch nhau vài phút, không đáng lo).
  //   - Trong vòng BILINGUAL_FAST_WINDOW_MS (24h) kể từ mốc đó: MỌI tick 20 phút đều chạy quét 1
  //     trang VSMOV (~72 lần/ngày, đủ phủ nhanh catalog).
  //   - Sau khi qua 24h: chỉ tick nào rơi đúng vào mốc 6 tiếng (phút = 0, giờ chia hết cho
  //     BILINGUAL_SLOW_INTERVAL_HOURS) mới thực sự quét — coi như tự động "hạ nhịp" về 6h/lần như
  //     bàn ban đầu, các tick 20 phút còn lại trong ngày no-op.
  //   - Muốn đổi ngưỡng (VD kéo dài "ngày đầu" thành 48h, hay đổi nhịp chậm thành 4h) chỉ sửa 2
  //     hằng số bên dưới, KHÔNG cần đụng wrangler.toml lần nữa.
  //
  // Đồng bộ lịch chiếu (syncScheduleCache) giữ nguyên Ý ĐỊNH cũ là chạy mỗi 6h — dùng CHUNG điều
  // kiện "tick rơi đúng mốc 6h" ở trên, không cần cron pattern riêng nữa.
  async scheduled(event, env, ctx) {
    const now = new Date();
    const isSixHourTick = now.getUTCMinutes() === 0 && (now.getUTCHours() % 6 === 0);

    // Lịch chiếu: luôn chỉ chạy đúng mốc 6h, giữ nguyên nhịp cũ.
    if (isSixHourTick) {
      ctx.waitUntil(syncScheduleCache(env));
    }

    // Badge song ngữ: throttle theo TIẾN ĐỘ THẬT (đã quét hết 1 vòng catalog chưa) thay vì đoán
    // mốc thời gian cố định — bản v36 đoán "24h đầu chắc quét xong" nhưng catalog VSMOV thực tế
    // ~18k phim nên đoán sai hoàn toàn (24h chỉ quét được phần nhỏ, sau đó tụt xuống 6h/lần và mất
    // hàng tháng mới xong). v37: quét mỗi tick cho tới khi CHÍNH THỨC quét hết 1 vòng (bắt được
    // noMoreData: true từ runBilingualScanPage) rồi mới chuyển sang nhịp 6h — không cần biết trước
    // catalog lớn cỡ nào, tự thích ứng đúng lúc xong.
    ctx.waitUntil((async () => {
      const firstPassDone = await env.RECOMMENDED_KV.get('bilingual_scan_first_pass_done');

      // Đã quét xong vòng đầu rồi -> chỉ quét lại theo nhịp 6h (dùng chung isSixHourTick), để bắt
      // phim MỚI được VSMOV thêm vào mà không cần quét lại toàn bộ catalog mỗi tick nữa.
      if (firstPassDone && !isSixHourTick) return;

      const savedCursor = await env.RECOMMENDED_KV.get('bilingual_scan_cursor');
      const page = savedCursor ? (Number(savedCursor) || 1) : 1;
      try {
        const result = await runBilingualScanPage(env, page);
        console.log(`[bilingual_scan/cron] trang ${page}: quét ${result.scanned}, gắn mới ${result.newlyBadged?.length || 0}${result.noMoreData ? ' (hết dữ liệu, cursor không tăng)' : ''}`);

        // Chạm trang cuối catalog lần đầu -> đánh dấu xong vòng đầu, từ tick sau chuyển nhịp 6h.
        // (Không cần unset lại: dù VSMOV thêm phim mới khiến sau này lại "hết dữ liệu" lần nữa,
        // ghi đè '1' lên '1' không sao, và giữa các lần hết-dữ-liệu vẫn quét đều theo nhịp 6h.)
        if (result.noMoreData && !firstPassDone) {
          await env.RECOMMENDED_KV.put('bilingual_scan_first_pass_done', '1');
          console.log('[bilingual_scan/cron] Đã quét hết vòng đầu catalog -> chuyển sang nhịp 6h/lần.');
        }
      } catch (e) {
        console.log('[bilingual_scan/cron] lỗi:', String(e));
      }
    })());
  }
};
