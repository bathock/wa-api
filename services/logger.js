const timestamp = () => {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const normalize = (args) => {
  if (args.length === 0) return { message: '', meta: null };

  if (typeof args[0] === 'string') {
    return {
      message: args[0],
      meta: args[1] || null
    };
  }

  return {
    message: args[1] || '',
    meta: args[0] || null
  };
};

const write = (level, args) => {
  const { message, meta } = normalize(args);
  const line = `[${timestamp()}] ${level.toUpperCase()} ${message}`;

  if (meta) {
    console.log(line, meta);
    return;
  }

  console.log(line);
};

export const logger = {
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') {
      write('debug', args);
    }
  }
};

export default logger;
