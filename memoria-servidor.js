// ==========================================================================
// MEMORIA (juegan TODOS a la vez) - motor del servidor
//
// Reglas: grilla de 6x6. En cada ronda aparecen los números 1..N en celdas al azar
// y hay que tocarlos en orden. Ronda correcta = +1, ronda incorrecta = -1.
// Rondas: 3 de 4 números, 3 de 5, ... hasta 3 de 10. Dura 30 segundos.
//
// Diseño para gastar lo mínimo (Render/Vercel gratis, 4 jugadores):
//  - El servidor genera las 21 rondas UNA vez y viajan en el snapshot. Cada cliente
//    juega su tablero localmente, sin esperar a la red.
//  - Cada jugador manda UN mensaje por ronda terminada: { r, t:[celdas tocadas] }.
//    El servidor lo verifica contra la ronda real (no confía en "acerté").
//  - El marcador general NO se emite en cada punto: sale como mucho 2 veces por
//    segundo y solo si cambió ('memoria_tick', unos pocos bytes).
//  - El reloj arranca cuando TODOS los clientes ya están mirando el modal
//    ('memoria_listo'), así nadie pierde segundos por las animaciones del tablero.
// ==========================================================================
module.exports = function crearMotorMemoria(deps, override = {}) {
    const { io, obtenerPartida, armarWatchdog, emitirEstado, META } = deps;

    const CFG = Object.assign({
        CELDAS: 36,                  // 6 x 6
        DURACION: 30_000,            // ms de juego
        CUENTA_REGRESIVA: 3200,      // "3, 2, 1, ¡YA!"
        ESPERA_MAX_LISTOS: 12_000,   // si alguien nunca avisa que está listo, se arranca igual
        GRACIA_FIN: 700,             // margen para rondas que estaban "en vuelo" al terminar
        LARGO_INICIAL: 4,
        LARGO_MAX: 10,
        RONDAS_POR_LARGO: 3,
        MS_MIN_POR_TOQUE: 100,       // anti-trampa: nadie toca más rápido que esto (acumulado)
        TICK_MS: 500,                // cada cuánto se emite el marcador (si cambió)
        PREMIO_GANADOR: 3,           // casilleros que avanza(n) quien(es) más puntos hizo
        CASTIGO_ULTIMO: 2,           // casilleros que retrocede(n) quien(es) menos puntos hizo
        MODO_MEMORIA: false          // true: tras el primer acierto los números se tapan (test del chimpancé)
    }, override);

    let contador = 0;
    let intervaloTicks = null;
    const internos = new WeakMap(); // datos que NO viajan a los clientes

    // ---------- generación ----------
    function sortearCeldas(n) {
        const celdas = Array.from({ length: CFG.CELDAS }, (_, i) => i);
        for (let i = 0; i < n; i++) {                       // Fisher-Yates parcial
            const j = i + Math.floor(Math.random() * (CFG.CELDAS - i));
            [celdas[i], celdas[j]] = [celdas[j], celdas[i]];
        }
        return celdas.slice(0, n); // celdas[k] = dónde aparece el número k+1
    }

    function generarRondas() {
        const rondas = [];
        for (let largo = CFG.LARGO_INICIAL; largo <= CFG.LARGO_MAX; largo++) {
            for (let i = 0; i < CFG.RONDAS_POR_LARGO; i++) rondas.push(sortearCeldas(largo));
        }
        return rondas;
    }

    // ---------- helpers ----------
    function actual() {
        const p = obtenerPartida();
        const mj = p.minijuegoActivo;
        return (p.estado === 'MINIJUEGO' && mj && mj.tipo === 'memoria') ? mj : null;
    }
    const conectado = (id) => {
        const j = obtenerPartida().jugadores[id];
        return !!(j && j.conectado);
    };

    // ---------- ciclo de vida ----------
    // Juegan todos los conectados. `atacanteId` = quien cayó en el reto (sigue siendo el del turno).
    function crear(atacanteId) {
        const partida = obtenerPartida();
        const ids = Object.values(partida.jugadores).filter(j => j.conectado).map(j => j.id);
        const mj = {
            tipo: 'memoria',
            id: ++contador,
            atacanteId,
            jugadores: ids,                                   // arrays paralelos: mismo índice = mismo jugador
            nombres: ids.map(id => partida.jugadores[id].nombre),
            avatares: ids.map(id => partida.jugadores[id].avatar),
            modoMemoria: CFG.MODO_MEMORIA,
            cuenta: CFG.CUENTA_REGRESIVA,
            duracion: CFG.DURACION,
            inicio: null,                                     // se fija cuando todos están listos
            fin: null,
            rondas: generarRondas(),
            puntos: ids.map(() => 0),
            progreso: ids.map(() => 0),                       // rondas ya entregadas por cada uno
            terminado: false,
            mensaje: null
        };
        internos.set(mj, { listos: new Set(), toques: ids.map(() => 0), sucio: false });
        return mj;
    }

    function arrancar(mj) {
        if (mj.inicio) return;
        mj.inicio = Date.now() + CFG.CUENTA_REGRESIVA;
        mj.fin = mj.inicio + CFG.DURACION;
        io.emit('memoria_inicio', { id: mj.id, inicio: mj.inicio, fin: mj.fin });
        armarWatchdog();      // ahora el watchdog vigila el fin de la ronda
        iniciarTicks(mj);
    }

    // Cada cliente avisa cuando ya está mostrando el modal
    function listo(jugadorId) {
        const mj = actual();
        if (!mj || mj.inicio || mj.terminado || !mj.jugadores.includes(jugadorId)) return;
        const int = internos.get(mj);
        int.listos.add(jugadorId);
        if (mj.jugadores.every(id => int.listos.has(id) || !conectado(id))) arrancar(mj);
    }

    // Un mensaje por ronda: { r: número de ronda, t: [celdas tocadas en orden] }
    function accion(jugadorId, d, responder) {
        const mj = actual();
        if (!mj || mj.terminado || !mj.inicio) return false;
        const i = mj.jugadores.indexOf(jugadorId);
        if (i < 0 || !d || !Number.isInteger(d.r) || !Array.isArray(d.t)) return false;

        const ahora = Date.now();
        if (ahora > mj.fin + CFG.GRACIA_FIN) return false;

        const ajustar = () => {
            if (responder) responder('memoria_ajuste', { id: mj.id, puntos: mj.puntos, progreso: mj.progreso });
            return false;
        };

        if (d.r !== mj.progreso[i] || d.r >= mj.rondas.length) return ajustar();  // fuera de orden / repetida
        const esperado = mj.rondas[d.r];
        if (d.t.length < 1 || d.t.length > esperado.length) return ajustar();
        if (!d.t.every(c => Number.isInteger(c) && c >= 0 && c < CFG.CELDAS)) return ajustar();

        // límite físico acumulado de toques por segundo
        const int = internos.get(mj);
        const permitidos = (ahora - mj.inicio + 600) / CFG.MS_MIN_POR_TOQUE;
        if (int.toques[i] + d.t.length > permitidos) return ajustar();

        const correcta = d.t.length === esperado.length && d.t.every((c, k) => c === esperado[k]);
        mj.puntos[i] += correcta ? 1 : -1;
        mj.progreso[i]++;
        int.toques[i] += d.t.length;
        int.sucio = true;
        return true;
    }

    function iniciarTicks(mj) {
        clearInterval(intervaloTicks);
        intervaloTicks = setInterval(() => {
            const p = obtenerPartida();
            if (p.minijuegoActivo !== mj || mj.terminado) return clearInterval(intervaloTicks);
            const int = internos.get(mj);
            if (!int.sucio) return;                 // nada cambió: no se manda nada
            int.sucio = false;
            io.emit('memoria_tick', { id: mj.id, p: mj.puntos, r: mj.progreso });
        }, CFG.TICK_MS);
    }

    function finalizar(mj) {
        if (!mj || mj.terminado) return;
        const partida = obtenerPartida();
        mj.terminado = true;
        clearInterval(intervaloTicks);

        const max = Math.max(...mj.puntos);
        const min = Math.min(...mj.puntos);

        if (max === min) {
            mj.mensaje = `EMPATE A ${max} PUNTOS. NADIE SE MUEVE.`;
        } else {
            const ganadores = [], ultimos = [];
            mj.puntos.forEach((pts, i) => {
                if (pts === max) ganadores.push(i);
                else if (pts === min) ultimos.push(i);
            });
            ganadores.forEach(i => {
                const j = partida.jugadores[mj.jugadores[i]];
                j.casillero = Math.min(META, j.casillero + CFG.PREMIO_GANADOR);
            });
            ultimos.forEach(i => {
                const j = partida.jugadores[mj.jugadores[i]];
                j.casillero = Math.max(0, j.casillero - CFG.CASTIGO_ULTIMO);
            });
            const nombres = (idx) => idx.map(i => mj.nombres[i]).join(' y ');
            mj.mensaje =
                `¡GANÓ ${nombres(ganadores)} CON ${max}! ${ganadores.length > 1 ? 'AVANZAN' : 'AVANZA'} ${CFG.PREMIO_GANADOR}. ` +
                `${ultimos.length > 1 ? 'ÚLTIMOS' : 'ÚLTIMO'}: ${nombres(ultimos)} ${ultimos.length > 1 ? 'RETROCEDEN' : 'RETROCEDE'} ${CFG.CASTIGO_ULTIMO}.`;
        }

        armarWatchdog();   // arma el cierre del modal
        emitirEstado();    // snapshot final con puntajes definitivos
    }

    // Lo llama el watchdog: si todavía no arrancó, arranca; si ya arrancó, termina.
    function vencio() {
        const mj = actual();
        if (!mj || mj.terminado) return;
        if (!mj.inicio) arrancar(mj);
        else finalizar(mj);
    }

    function msHastaVencer() {
        const mj = actual();
        if (!mj) return 1000;
        return mj.inicio ? Math.max(1000, mj.fin - Date.now() + CFG.GRACIA_FIN) : CFG.ESPERA_MAX_LISTOS;
    }

    return { crear, listo, accion, vencio, msHastaVencer, CFG };
};