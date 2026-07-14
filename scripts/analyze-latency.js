'use strict';

var fs = require('node:fs');

var METRICS = {
  worker_authenticated: 'durationMs',
  telegram_update_queued: 'edgeTotalMs',
  queue_received: 'queueWaitMs',
  domain_completed: 'durationMs',
  transaction_completed: 'durationMs',
  telegram_send_completed: 'durationMs',
  telegram_request_completed: 'durationMs',
  telegram_fast_path_domain_completed: 'domainDurationMs',
  telegram_fast_path_completed: 'totalDurationMs',
  telegram_update_forwarded: 'endToEndMs'
};

function percentile(sorted, ratio) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function parseLine(line) {
  line = line.trim();
  if (!line) return null;
  var firstBrace = line.indexOf('{');
  if (firstBrace < 0) return null;
  try {
    var value = JSON.parse(line.slice(firstBrace));
    if (value && typeof value.message === 'string' && value.message.charAt(0) === '{') {
      try { return JSON.parse(value.message); }
      catch (ignore) {}
    }
    return value;
  } catch (ignore) {
    return null;
  }
}

function main() {
  var input = fs.readFileSync(0, 'utf8');
  var samples = {};
  Object.keys(METRICS).forEach(function (event) { samples[event] = []; });

  input.split(/\r?\n/).forEach(function (line) {
    var entry = parseLine(line);
    if (!entry || !METRICS[entry.event]) return;
    var value = Number(entry[METRICS[entry.event]]);
    if (Number.isFinite(value) && value >= 0) samples[entry.event].push(value);
  });

  console.log('stage\tsamples\tp50_ms\tp95_ms\tmax_ms');
  Object.keys(METRICS).forEach(function (event) {
    var values = samples[event].sort(function (left, right) { return left - right; });
    console.log([
      event,
      values.length,
      percentile(values, 0.5) == null ? '-' : percentile(values, 0.5),
      percentile(values, 0.95) == null ? '-' : percentile(values, 0.95),
      values.length ? values[values.length - 1] : '-'
    ].join('\t'));
  });
}

main();
