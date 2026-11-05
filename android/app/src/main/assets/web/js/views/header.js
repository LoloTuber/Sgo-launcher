export function renderHeader(student) {
  if (!student) return;
  const bits = [student.name, student.class && `${student.class} класс`, student.term]
    .filter(Boolean);
  document.querySelector("#who").textContent = bits.join(" · ") || "Дневник";
  
  if (typeof student.average === "number") {
    document.querySelector("#avg").textContent = student.average.toFixed(2).replace(".", ",");
    document.querySelector("#avg-box").hidden = false;
  } else {
    document.querySelector("#avg-box").hidden = true;
  }

  const vacBox = document.querySelector("#vac-box");
  if (student.vacation) {
    const d = student.vacation.days;
    if (d === 0) {
      document.querySelector("#vac-days").textContent = "Ура!";
      document.querySelector("#vac-label").textContent = "каникулы!";
    } else if (d === 1) {
      document.querySelector("#vac-days").textContent = "1";
      document.querySelector("#vac-label").textContent = "день";
    } else {
      document.querySelector("#vac-days").textContent = d;
      document.querySelector("#vac-label").textContent = "до каникул";
    }
    vacBox.title = student.vacation.name;
    vacBox.hidden = false;
  } else {
    vacBox.hidden = true;
  }
}