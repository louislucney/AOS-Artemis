export function logcatTime(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

export function logcatLine(date, level, tag, message, pid = 1000) {
  return `${logcatTime(date)}  ${pid}  ${pid} ${level} ${tag}: ${message}`;
}
