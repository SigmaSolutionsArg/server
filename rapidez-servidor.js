// ==========================================================================
// RAPIDEZ VISUAL (juegan TODOS a la vez) - motor del servidor
//
// Reglas: caen objetos en la pantalla. Los verdes puros suman punto (algunos
// piden varios clicks o mantener apretado), el resto resta si se tocan.
// Gana quien llegue primero a la meta de puntos, o quien vaya ganando cuando
// se acaba el tiempo.
//
// Mismo patrón que memoria-servidor.js: arranca al crearse (no espera "listos"
// porque acá no hay tablero propio por jugador, todos comparten los mismos
// objetos en el mismo instante), y cada acierto/error se resuelve al toque,
// sin confiar en lo que diga el cliente sobre el resultado.
// ==========================================================================
module.exports = function crearMotorRapidez(deps, override = {}) {
    const { io, obtenerPartida, armarWatchdog, emitirEstado, META } = deps;

    const CFG = Object.assign({
        META_PUNTOS: 10,
        DURACION: 60_000,
        CUENTA_REGRESIVA: 3200,
        INTERVALO_MIN: 190,
        INTERVALO_MAX: 430,
        TOLERANCIA: 400,          // margen de red para aceptar un toque
        GRACIA_FIN: 500,          // margen para toques que estaban "en vuelo" al terminar
        PREMIO_GANADOR: 2,        // casilleros que avanza(n) quien(es) más puntos hizo
        CASTIGO_ULTIMO: 2         // casilleros que retrocede(n) quien(es) menos puntos hizo
    }, override);

    const TIPOS_BUENOS = [
        { tipo: 'verde', peso: 58, dura: [850, 1450] },
        { tipo: 'verde_multi', peso: 20, dura: [2000, 2800], clicks: 5 },
        { tipo: 'verde_hold', peso: 22, dura: [2000, 2800], hold: 900 }
    ];
    const TIPOS_MALOS = [
        { tipo: 'turquesa', peso: 18, dura: [700, 1250] },
        { tipo: 'lima', peso: 16, dura: [700, 1250] },
        { tipo: 'cuadrado', peso: 14, dura: [800, 1400] },
        { tipo: 'rombo', peso: 11, dura: [800, 1400] },
        { tipo: 'cruz', peso: 11, dura: [900, 1500] },
        { tipo: 'rojo', peso: 12, dura: [800, 1400] },
        { tipo: 'emoji', peso: 18, dura: [800, 1500] }
    ];
    const EMOJIS_TRAMPA = ['🥑', '🐸', '🍀', '🟩', '🥦', '🫒', '🍏', '🐍', '🌲', '🦖', '🧪', '🍐', '🥝'];

    let contador = 0;

    // ---------- generación ----------
    const azar = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    function elegirPonderado(lista) {
        const total = lista.reduce((s, x) => s + x.peso, 0);
        let r = Math.random() * total;
        for (const x of lista) { if ((r -= x.peso) <= 0) return x; }
        return lista[lista.length - 1];
    }
    function generarObjetos() {
        const objetos = [];
        let t = 0, id = 0;
        while (t < CFG.DURACION) {
            const progreso = t / CFG.DURACION;
            const escala = 1 - 0.35 * progreso;
            t += Math.round(azar(CFG.INTERVALO_MIN, CFG.INTERVALO_MAX) * escala);
            const bueno = Math.random() < 0.38;
            const plantilla = elegirPonderado(bueno ? TIPOS_BUENOS : TIPOS_MALOS);
            const o = { id: id++, tipo: plantilla.tipo, bueno, x: azar(8, 92), y: azar(10, 90), tam: azar(38, 66), aparece: t, dura: Math.round(azar(plantilla.dura[0], plantilla.dura[1]) * escala) };
            if (plantilla.clicks) o.clicks = plantilla.clicks;
            if (plantilla.hold) o.hold = plantilla.hold;
            if (plantilla.tipo === 'emoji') o.emoji = EMOJIS_TRAMPA[azar(0, EMOJIS_TRAMPA.length - 1)];
            if (Math.random() < 0.3) { o.dx = azar(-22, 22); o.dy = azar(-22, 22); }
            objetos.push(o);
        }
        return objetos;
    }
    function buscar(mj, id) { return mj.objetos.find(o => o.id === id) || null; }

    // ---------- helpers ----------
    function actual() {
        const p = obtenerPartida();
        const mj = p.minijuegoActivo;
        return (p.estado === 'MINIJUEGO' && mj && mj.tipo === 'rapidez') ? mj : null;
    }

    // ---------- ciclo de vida ----------
    function crear(atacanteId) {
        const partida = obtenerPartida();
        const ids = Object.values(partida.jugadores).filter(j => j.conectado).map(j => j.id);
        const inicio = Date.now() + CFG.CUENTA_REGRESIVA;
        return {
            tipo: 'rapidez',
            id: ++contador,
            atacanteId,
            jugadores: ids,                                  // arrays paralelos: mismo índice = mismo jugador
            nombres: ids.map(id => partida.jugadores[id].nombre),
            avatares: ids.map(id => partida.jugadores[id].avatar),
            inicio,
            fin: inicio + CFG.DURACION,
            meta: CFG.META_PUNTOS,
            objetos: generarObjetos(),
            puntos: ids.map(() => 0),
            tomados: {},                                     // idObjeto -> índice del jugador que lo tomó
            golpes: {},                                       // idObjeto -> { índice: cantidad de clicks }
            errores: {},                                      // idObjeto -> { índice: true } (un solo descuento por objeto malo)
            terminado: false,
            mensaje: null
        };
    }

    // Un mensaje por toque: { idObjeto, accion? }
    function accion(jugadorId, datos) {
        const mj = actual();
        if (!mj || mj.terminado || !mj.inicio) return false;
        const i = mj.jugadores.indexOf(jugadorId);
        if (i < 0) return false;

        const idObjeto = datos && datos.idObjeto;
        if (!Number.isInteger(idObjeto)) return false;

        const o = buscar(mj, idObjeto);
        // OJO: comparar con undefined, no con verdad/falsedad: el índice 0 es
        // un jugador válido y "falsy", así que `!mj.tomados[idObjeto]` dejaría
        // que le roben sus objetos ya tomados.
        if (!o || mj.tomados[idObjeto] !== undefined) return false;

        const ahora = Date.now() - mj.inicio;
        if (ahora < -CFG.TOLERANCIA) return false;
        if (ahora < o.aparece - CFG.TOLERANCIA || ahora > o.aparece + o.dura + CFG.TOLERANCIA) return false;

        let resultado;
        if (!o.bueno) {
            const err = mj.errores[idObjeto] || (mj.errores[idObjeto] = {});
            if (err[i]) return false;                          // ya se descontó por este objeto a este jugador
            err[i] = true; mj.puntos[i] = Math.max(0, mj.puntos[i] - 1); resultado = 'fallo';
        } else if (o.hold) {
            if (!datos || datos.accion !== 'hold') return false;
            mj.tomados[idObjeto] = i; mj.puntos[i]++; resultado = 'punto';
        } else if (o.clicks) {
            const g = mj.golpes[idObjeto] || (mj.golpes[idObjeto] = {});
            g[i] = (g[i] || 0) + 1;
            if (g[i] >= o.clicks) { mj.tomados[idObjeto] = i; mj.puntos[i]++; resultado = 'punto'; }
            else resultado = 'progreso';
        } else {
            mj.tomados[idObjeto] = i; mj.puntos[i]++; resultado = 'punto';
        }

        io.emit('rapidez_tick', { id: mj.id, idObjeto, jugadorIndex: i, resultado, golpes: mj.golpes[idObjeto] || null, puntos: mj.puntos });
        if (mj.puntos[i] >= mj.meta) finalizar(mj);
        return true;
    }

    function finalizar(mj) {
        if (!mj || mj.terminado) return;
        const partida = obtenerPartida();
        mj.terminado = true;

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

    // Lo llama el watchdog cuando se acabó el tiempo.
    function vencio() {
        const mj = actual();
        if (!mj || mj.terminado) return;
        finalizar(mj);
    }

    function msHastaVencer() {
        const mj = actual();
        if (!mj) return 1000;
        return Math.max(500, mj.fin - Date.now() + CFG.GRACIA_FIN);
    }

    return { crear, accion, vencio, msHastaVencer, CFG };
};