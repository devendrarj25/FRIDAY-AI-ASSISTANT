/**
 * Cloud side router. It only partitions a catalogue the master router already
 * classified. It does not choose a lane and it does not call a provider.
 */
"use strict";

function splitLanes(models, options = {}) {
  const paidOpen = options.paidOpen === true;
  const free = [];
  const paid = [];
  const unknown = [];
  for (const model of models || []) {
    if (model?.access === "free") free.push(model);
    else if (model?.access === "paid") paid.push(model);
    else unknown.push(model);
  }
  return {
    free,
    paid: paidOpen ? paid : [],
    unknown,
    droppedPaid: !paidOpen && paid.length > 0,
  };
}

module.exports = { splitLanes };
