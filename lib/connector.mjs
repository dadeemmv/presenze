/**
 * Il connettore MCP di yoU@B: l'unico pezzo che parla col sito Bocconi.
 *
 * Lo studente gli da' accesso facendo il login dall'app (la password non passa mai di qui:
 * il connettore riceve solo la sessione gia' aperta). Da li' sa fare quello che fai tu a mano:
 * leggere il calendario della home, aprire "Registra la tua presenza", cliccare la lezione.
 *
 * Lo usa l'app stessa, in processo (InMemoryTransport), e lo espone su /mcp per un client
 * esterno come Claude, con lo stesso token dell'app.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LoginError } from './http.mjs';
import * as B from './bocconi.mjs';

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (e) => ({
  isError: true,
  content: [{ type: 'text', text: e.message }],
  structuredContent: { error: e.message, relogin: e instanceof LoginError },
});
const wrap = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e);
  }
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data YYYY-MM-DD, ora di Milano');

/** Il pannello di una lezione nella pagina presenze, scelto per orario d'inizio se ce n'e' piu' d'uno. */
async function panelFor(client, extcode, date, startHHMM) {
  const panels = await B.attendanceState(client, extcode, date);
  return (startHHMM && panels.find((p) => p.time?.[0] === startHHMM)) || panels[0] || null;
}

const stateOf = (p) =>
  !p ? 'not_found' : p.registered ? 'registered' : p.pk?.value ? 'open' : 'not_open';

export function createConnector(client, { username } = {}) {
  const server = new McpServer({ name: 'youatb', version: '0.1.0' });

  server.registerTool(
    'youatb_session',
    {
      title: 'Sessione yoU@B',
      description: "Dice se il connettore ha accesso a yoU@B e per quale matricola. Se la sessione e' scaduta lo studente deve rifare il login dall'app.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    wrap(async () => {
      try {
        await B.lessons(client, B.romeNow().slice(0, 10), B.romeNow().slice(0, 10));
        return { connected: true, username: username?.() ?? null, now: B.romeNow() };
      } catch (e) {
        if (e instanceof LoginError) return { connected: false, username: username?.() ?? null, reason: e.message };
        throw e;
      }
    })
  );

  server.registerTool(
    'youatb_calendar',
    {
      title: 'Calendario lezioni',
      description: "Le lezioni dello studente dal calendario della home di yoU@B: corso, extcode, orari, aula, docenti e coordinate dell'aula.",
      inputSchema: { from: day.optional(), to: day.optional() },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ from, to }) => {
      const d = B.romeNow().slice(0, 10);
      return { lessons: await B.lessons(client, from || d, to || from || d) };
    })
  );

  server.registerTool(
    'youatb_attendance_status',
    {
      title: 'Stato presenza',
      description: "Apre \"Registra la tua presenza\" per una lezione e dice se la presenza e' gia' registrata, se la rilevazione e' aperta dal docente o non ancora avviata.",
      inputSchema: {
        extcode: z.string().describe('Codice lezione, es. 30012_01_2026 (da youatb_calendar)'),
        date: day.optional(),
        start: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("Ora d'inizio HH:MM, se quel giorno ci sono piu' lezioni dello stesso corso"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ extcode, date, start }) => {
      const p = await panelFor(client, extcode, date || B.romeNow().slice(0, 10), start);
      return { extcode, state: stateOf(p), messages: p?.alerts ?? [], options: p?.where ?? [] };
    })
  );

  server.registerTool(
    'youatb_register_attendance',
    {
      title: 'Registra presenza',
      description:
        "Clicca \"Registra la tua presenza\" sulla lezione, come farebbe lo studente. Funziona solo se il docente ha aperto la rilevazione; se e' gia' registrata non fa nulla.",
      inputSchema: {
        extcode: z.string(),
        date: day.optional(),
        start: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    wrap(async ({ extcode, date, start }) => {
      const p = await panelFor(client, extcode, date || B.romeNow().slice(0, 10), start);
      const state = stateOf(p);
      if (state !== 'open') return { extcode, state, registered: state === 'registered', messages: p?.alerts ?? [] };
      const where = B.pickOnCampus(p.where);
      if (p.where.length && !where) {
        return { extcode, state: 'error', registered: false, messages: [`Opzione "in aula" non riconosciuta: ${p.where.map((w) => w.label || w.value).join(', ')}`] };
      }
      const res = await B.register(client, extcode, { pk: p.pk.value, pin: p.pin?.value || '', where: where?.value || '' });
      return {
        extcode,
        state: res.isSuccessful ? 'registered' : 'error',
        registered: !!res.isSuccessful,
        messages: [res.message || (res.isSuccessful ? 'Presenza registrata.' : 'Presenza non registrata.')],
      };
    })
  );

  return server;
}
