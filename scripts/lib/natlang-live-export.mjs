/** Code for the existing eval API. Run after the original eval receipt, on that same owned eval entity. */
export function natlangRunExportCode({ runId, rootCallIds }) {
  if (typeof runId !== 'string' || !runId || !Array.isArray(rootCallIds) || !rootCallIds.length ||
      rootCallIds.some(id => typeof id !== 'string' || !id) || new Set(rootCallIds).size !== rootCallIds.length)
    throw new TypeError('export requires the original eval run and its explicit root call IDs');
  return `return await (async () => {
    const runId = ${JSON.stringify(runId)}, expectedRoots = ${JSON.stringify(rootCallIds)};
    async function page(after) {
      const rows = await natlang.calls({run:runId,...(after?{after}:{})});
      if (!rows.length) return [];
      const next = rows[rows.length-1].callId;
      if (next === after) throw new Error('natlang records pagination did not advance');
      return rows.concat(await page(next));
    }
    const rows = await page(), ids = new Set(rows.map(row=>row.callId));
    const roots = rows.filter(row=>row.parentCallId===null).map(row=>row.callId);
    if (roots.length!==expectedRoots.length || roots.some(id=>!expectedRoots.includes(id))) throw new Error('natlang export root lineage differs from completed eval');
    const calls = [];
    for (const row of rows) {
      const detail = await natlang.trace(row.callId,{raw:true});
      if (!detail.record || detail.summary?.run_id!==runId || detail.record.call_id!==row.callId ||
          (detail.record.parent_call_id!==null && !ids.has(detail.record.parent_call_id))) throw new Error('natlang export has missing record or mismatched run lineage');
      if (calls.length && (detail.summary.owner_key!==calls[0].summary.owner_key || detail.summary.owner_kind!==calls[0].summary.owner_kind)) throw new Error('natlang export crosses eval owners');
      calls.push(detail);
    }
    return {runId,rootCallIds:expectedRoots,calls};
  })();`;
}

/** Direct actual-program invocation; setup constructs the caller's real scoped service ports, outside model source. */
export function natlangProgramInvocationCode({programPath, args = [], executorModel, setup = '', serviceBindings = {}}) {
  if (typeof programPath !== 'string' || !programPath || !Array.isArray(args) || typeof executorModel !== 'string' || !executorModel.includes(':'))
    throw new TypeError('direct invocation requires an actual program path, argument list and provider:id teacher');
  for (const [name, variable] of Object.entries(serviceBindings))
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || !/^[A-Za-z_$][\w$]*$/.test(variable)) throw new TypeError('service bindings name real caller-owned variables');
  return `${setup}\nnatlang.captureModelTurns(${JSON.stringify({executorModel})});\n` +
    `const program = await natlang.load(${JSON.stringify(programPath)}, {services:{${Object.entries(serviceBindings).map(([name, variable])=>`${JSON.stringify(name)}:${variable}`).join(',')}}});\n` +
    `return await program(...${JSON.stringify(args)});`;
}
