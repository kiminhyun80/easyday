// Easyday 공휴일 프록시 (Google Apps Script)
// 1) script.google.com → 새 프로젝트 → 이 코드 붙여넣기
// 2) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스: 모든 사용자 → 배포
// 3) 생성된 /exec 주소를 Easyday ⋯ → 공휴일 자동 갱신 칸에 붙여넣기
function doGet(e) {
  var year = Number(e && e.parameter && e.parameter.year) || new Date().getFullYear();
  var ics = UrlFetchApp.fetch(
    "https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics"
  ).getContentText();
  var out = {};
  ics.split("BEGIN:VEVENT").slice(1).forEach(function (ev) {
    var d = (ev.match(/DTSTART;VALUE=DATE:(\d{8})/) || [])[1];
    var name = (ev.match(/SUMMARY:(.*)/) || [])[1];
    var desc = (ev.match(/DESCRIPTION:(.*)/) || [])[1] || "";
    if (!d || !name || d.slice(0, 4) != String(year)) return;
    if (desc && desc.indexOf("공휴일") < 0) return; // 제헌절·어버이날 같은 기념일은 제외
    out[d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6, 8)] = name.trim();
  });
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
