export async function fetchJson(url, options) {
  const res = await fetch(url, Object.assign(
    { headers: { Accept: "application/json" } }, options,
  ));
  let payload = null;
  try { payload = await res.json(); }
  catch (e) { throw new Error(`Сервер вернул не JSON (HTTP ${res.status})`); }
  if (res.status === 401) {
    // Сессия СГО не восстановилась — покажем экран входа.
    window.dispatchEvent(new CustomEvent("sgo:unauthorized"));
  }
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error || `Ошибка HTTP ${res.status}`);
  }
  return payload;
}

export const getQuick = () => fetchJson("/api/quick");

export const getGrades = (term) => {
  const url = term ? `/api/grades?term=${encodeURIComponent(term)}` : "/api/grades";
  return fetchJson(url);
};

export const getResults = (term, mode) => {
  const params = new URLSearchParams();
  if (term) params.set("term", term);
  if (mode) params.set("mode", mode);
  const qs = params.toString();
  return fetchJson(qs ? `/api/results?${qs}` : "/api/results");
};

export const getDiary = (weekIso) => {
  const url = weekIso ? `/api/diary?week=${weekIso}` : "/api/diary";
  return fetchJson(url);
};

export const getSchedule = (weekIso) => {
  const url = weekIso ? `/api/schedule?week=${weekIso}` : "/api/schedule";
  return fetchJson(url);
};

export const getAssignmentDetails = (id) => fetchJson(`/api/assignment/${encodeURIComponent(id)}`);

export const postRefresh = () => fetch("/api/refresh", { method: "POST" }).catch(() => null);