/**
 * Использование уже загруженных данных.
 *
 * Дневник содержит всё: уроки, домашнее задание и оценки. Поэтому, если
 * отдельные вкладки не загрузились (сервер не ответил или их не открывали),
 * расписание и ДЗ можно собрать из дневника, а новые оценки — посчитать
 * по его отметкам.
 */

const MONTHS = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** «15 ноября» — как в отчёте СГО. */
export function ruDateLabel(iso) {
  const parts = String(iso || "").slice(0, 10).split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "";
  const [, month, day] = parts;
  if (month < 1 || month > 12) return "";
  return `${day} ${MONTHS[month - 1]}`;
}

/** Расписание недели из дневника — уроки в дневнике те же, что и в расписании. */
export function scheduleFromDiary(diary) {
  if (!diary || !Array.isArray(diary.days) || !diary.days.length) return null;

  const days = diary.days.map((day) => ({
    date: day.date,
    weekday: day.weekday,
    lessons: (day.lessons || []).map((lesson) => ({
      number: lesson.number,
      subject: lesson.subject,
      start: lesson.start || "",
      end: lesson.end || "",
      room: lesson.room || "",
    })),
  }));

  return {
    weekStart: diary.weekStart,
    weekEnd: diary.weekEnd,
    days,
    derived: true,
  };
}

/** Домашнее задание на указанный день — из дневника. */
export function homeworkFromDiary(diary, dateIso) {
  if (!diary || !Array.isArray(diary.days)) return null;
  const day = diary.days.find((item) => item.date === dateIso);
  if (!day) return null;

  const lessons = (day.lessons || [])
    .map((lesson) => {
      const tasks = (lesson.tasks || [])
        .filter((task) => String(task && task.text || "").trim())
        .map((task) => ({
          id: task.id,
          text: task.text,
          type: task.type || "",
        }));
      return {
        number: lesson.number,
        subject: lesson.subject,
        room: lesson.room || "",
        start: lesson.start || "",
        end: lesson.end || "",
        tasks,
      };
    })
    .filter((lesson) => lesson.tasks.length);

  if (!lessons.length) return null;

  return {
    date: day.date,
    label: ruDateLabel(day.date),
    isTomorrow: false,
    note: "",
    lessons,
    tasksCount: lessons.reduce((n, lesson) => n + lesson.tasks.length, 0),
    derived: true,
  };
}
