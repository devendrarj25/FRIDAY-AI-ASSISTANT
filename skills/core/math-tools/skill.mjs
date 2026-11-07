// FRIDAY · skill: math-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Calculator, primes, combinations, equations, geometry and fractions. Exact maths that a language model would otherwise guess.
// It holds 6 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "calc",
    gate: /\d\s*[-+*/^×÷%]\s*\d|sqrt|\bsin\b|\bcos\b|\btan\b|\bln\b|\blog\b|\d!|factorial|power|plus|minus|times|divided|square root|\bmod\b/,
    run: (() => {
      // Calculator: evaluates an arithmetic expression with its own parser (no eval), so the answer is computed, not guessed.
      const FUNCS = {
        sqrt: Math.sqrt,
        cbrt: Math.cbrt,
        abs: Math.abs,
        ln: Math.log,
        log: Math.log10,
        log10: Math.log10,
        log2: Math.log2,
        exp: Math.exp,
        floor: Math.floor,
        ceil: Math.ceil,
        round: Math.round,
        sign: Math.sign,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        asin: Math.asin,
        acos: Math.acos,
        atan: Math.atan,
        min: Math.min,
        max: Math.max,
        pow: Math.pow,
        hypot: Math.hypot,
      };
      const TRIG = new Set(["sin", "cos", "tan"]);
      const INVTRIG = new Set(["asin", "acos", "atan"]);
      const CONST = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

      function tokenize(src) {
        const out = [];
        const re =
          /\s*(?:(\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+)|([a-z_][a-z0-9_]*)|(\*\*|[-+*/^%(),!]))/gy;
        let m;
        let pos = 0;
        while (pos < src.length) {
          re.lastIndex = pos;
          m = re.exec(src);
          if (!m) {
            if (/^\s*$/.test(src.slice(pos))) break;
            throw new Error(`Unexpected "${src.slice(pos).trim()[0]}"`);
          }
          pos = re.lastIndex;
          if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
          else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
          else out.push({ t: "op", v: m[3] === "**" ? "^" : m[3] });
        }
        return out;
      }

      function evaluate(src, deg) {
        const toks = tokenize(src);
        let i = 0;
        const peek = () => toks[i];
        const eat = (v) => {
          if (peek() && peek().t === "op" && peek().v === v) return toks[i++];
          return null;
        };
        const fact = (n) => {
          if (!Number.isInteger(n) || n < 0 || n > 170)
            throw new Error("Factorial needs a whole number from 0 to 170.");
          let r = 1;
          for (let k = 2; k <= n; k++) r *= k;
          return r;
        };
        function expr() {
          let v = term();
          for (;;) {
            if (eat("+")) v += term();
            else if (eat("-")) v -= term();
            else return v;
          }
        }
        function term() {
          let v = unary();
          for (;;) {
            if (eat("*")) v *= unary();
            else if (eat("/")) {
              const d = unary();
              if (d === 0) throw new Error("Division by zero.");
              v /= d;
            } else if (eat("%")) {
              const d = unary();
              if (d === 0) throw new Error("Division by zero.");
              v %= d;
            } else if (peek() && peek().t === "id" && peek().v === "mod") {
              i++;
              v %= unary();
            } else return v;
          }
        }
        function unary() {
          if (eat("-")) return -unary();
          if (eat("+")) return unary();
          return power();
        }
        function power() {
          const base = postfix();
          if (eat("^")) return Math.pow(base, unary());
          return base;
        }
        function postfix() {
          let v = primary();
          while (eat("!")) v = fact(v);
          return v;
        }
        function primary() {
          const tk = toks[i++];
          if (!tk) throw new Error("The expression ends too early.");
          if (tk.t === "num") return tk.v;
          if (tk.t === "id") {
            if (eat("(")) {
              const args = [];
              if (!eat(")")) {
                do args.push(expr());
                while (eat(","));
                if (!eat(")")) throw new Error("Missing )");
              }
              const f = FUNCS[tk.v];
              if (!f) throw new Error(`Unknown function ${tk.v}`);
              if (deg && TRIG.has(tk.v)) args[0] = (args[0] * Math.PI) / 180;
              const r = f(...args);
              return deg && INVTRIG.has(tk.v) ? (r * 180) / Math.PI : r;
            }
            if (tk.v in CONST) return CONST[tk.v];
            throw new Error(`Unknown word "${tk.v}"`);
          }
          if (tk.v === "(") {
            const v = expr();
            if (!eat(")")) throw new Error("Missing )");
            return v;
          }
          throw new Error(`Unexpected "${tk.v}"`);
        }
        const v = expr();
        if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
        return v;
      }

      async function run(input = {}) {
        let src = String(input.expression ?? input?.prompt ?? input?.text ?? "").toLowerCase();
        if (src.length > 500) return { ok: false, error: "Expression is too long." };
        const deg = /\bdeg(?:rees?)?\b|°/.test(src) || input.angle === "deg";
        if (/\d+(?:\.\d+)?\s*%\s*(?:of|ka|ki)\b/.test(src))
          return { ok: false, error: "That is a percentage question, not plain arithmetic." };
        src = src
          .replace(/[,](?=\d{3}\b)/g, "")
          .replace(/×/g, "*")
          .replace(/÷/g, "/")
          .replace(/\bsquare root of\b/g, "sqrt")
          .replace(
            /\b(?:what is|what's|calculate|compute|evaluate|solve|find|the value of|equals?|kitna hota hai|kya hai)\b/g,
            " ",
          )
          .replace(/\bplus\b/g, "+")
          .replace(/\bminus\b/g, "-")
          .replace(/\b(?:times|multiplied by|into)\b/g, "*")
          .replace(/\b(?:divided by|over)\b/g, "/")
          .replace(/\bto the power(?: of)?\b/g, "^")
          .replace(/\bfactorial of (\d+)/g, "$1!")
          .replace(/\bdegrees?\b|\bdeg\b|°/g, " ")
          .replace(/[=?]/g, " ")
          .replace(/(\d)\s*x\s*(\d)/g, "$1*$2")
          .replace(/(\))\s*(\d|\()/g, "$1*$2")
          .replace(/(\d)\s*\(/g, "$1*(")
          .trim();
        if (!/\d/.test(src)) return { ok: false, error: "No numbers found." };
        if (!/[-+*/^%!(]|\bmod\b|[a-z]+\s*\(|\bpi\b/.test(src))
          return { ok: false, error: "Not an expression." };
        let v;
        try {
          v = evaluate(src, deg);
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
        if (!Number.isFinite(v)) return { ok: false, error: "The result is not a finite number." };
        const clean = Number(v.toPrecision(12));
        return {
          ok: true,
          expression: src,
          result: clean,
          answer: `${src.replace(/\*/g, " x ")} = ${clean}${deg ? " (angles in degrees)" : ""}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "number-theory",
    gate: /\bgcd\b|\bhcf\b|\blcm\b|prime|factor(?:ize|s)?\b|fibonacci|divisor/,
    run: (() => {
      // Number theory: gcd and lcm, primality, prime factors, divisors, Fibonacci, primes up to N.
      const nums = (t) =>
        (t.match(/\d+/g) ?? []).map((n) => BigInt(n)).filter((n) => n < 10n ** 15n);
      const gcd = (a, b) => {
        while (b) [a, b] = [b, a % b];
        return a;
      };
      function factor(n) {
        const f = [];
        for (let p = 2n; p * p <= n; p += p === 2n ? 1n : 2n) {
          let c = 0;
          while (n % p === 0n) {
            n /= p;
            c++;
          }
          if (c) f.push([p, c]);
          if (p > 2000000n) break;
        }
        if (n > 1n) f.push([n, 1]);
        return f;
      }
      const isPrime = (n) =>
        n > 1n &&
        (() => {
          const f = factor(n);
          return f.length === 1 && f[0][1] === 1;
        })();

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const n = nums(t);
        if (!n.length)
          return {
            ok: false,
            error: "Give a number, e.g. gcd of 12 18, is 97 prime, factorize 360, fibonacci 20.",
          };
        if (/\bgcd\b|\bhcf\b|greatest common/.test(t) || /\blcm\b|least common/.test(t)) {
          if (n.length < 2) return { ok: false, error: "Give at least two numbers." };
          const g = n.reduce(gcd);
          const l = n.reduce((a, b) => (a / gcd(a, b)) * b);
          return {
            ok: true,
            gcd: String(g),
            lcm: String(l),
            answer: `GCD (HCF) = ${g}, LCM = ${l}.`,
          };
        }
        if (/fibonacci/.test(t)) {
          const k = Number(n[0]);
          if (k > 1000) return { ok: false, error: "Fibonacci index up to 1000." };
          let a = 0n;
          let b = 1n;
          for (let i = 0; i < k; i++) [a, b] = [b, a + b];
          return { ok: true, index: k, value: String(a), answer: `Fibonacci(${k}) = ${a}.` };
        }
        if (/primes?\s+(?:up to|below|under|till|upto)/.test(t)) {
          const lim = Number(n[0]);
          if (lim > 10000) return { ok: false, error: "Limit up to 10000." };
          const sieve = new Uint8Array(lim + 1);
          const list = [];
          for (let i = 2; i <= lim; i++) {
            if (!sieve[i]) {
              list.push(i);
              for (let j = i * i; j <= lim; j += i) sieve[j] = 1;
            }
          }
          return {
            ok: true,
            count: list.length,
            primes: list.slice(0, 200),
            answer: `${list.length} primes up to ${lim}${list.length > 200 ? " (first 200 listed)" : `: ${list.join(", ")}`}.`,
          };
        }
        if (/next prime/.test(t)) {
          let x = n[0] + 1n;
          while (!isPrime(x)) x++;
          return { ok: true, next: String(x), answer: `The next prime after ${n[0]} is ${x}.` };
        }
        if (/divisors?|factors of/.test(t) && !/prime factor/.test(t)) {
          const k = Number(n[0]);
          if (k > 1e9) return { ok: false, error: "Number up to 1,000,000,000." };
          const d = [];
          for (let i = 1; i * i <= k; i++)
            if (k % i === 0) {
              d.push(i);
              if (i * i !== k) d.push(k / i);
            }
          d.sort((a, b) => a - b);
          return {
            ok: true,
            divisors: d,
            answer: `${k} has ${d.length} divisors: ${d.join(", ")}.`,
          };
        }
        if (/prime/.test(t) && !/factor/.test(t)) {
          const f = factor(n[0]);
          const prime = n[0] > 1n && f.length === 1 && f[0][1] === 1;
          return {
            ok: true,
            prime,
            answer: prime
              ? `${n[0]} is prime.`
              : n[0] < 2n
                ? `${n[0]} is not prime.`
                : `${n[0]} is not prime: ${f.map(([p, c]) => (c > 1 ? `${p}^${c}` : String(p))).join(" x ")}.`,
          };
        }
        const f = factor(n[0]);
        return {
          ok: true,
          factors: f.map(([p, c]) => ({ prime: String(p), power: c })),
          answer: `${n[0]} = ${f.map(([p, c]) => (c > 1 ? `${p}^${c}` : String(p))).join(" x ") || "1"}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "combinatorics",
    gate: /choose|\bncr\b|\bnpr\b|factorial|permutation|combination|arrangement|\d!|\bc\(|\bp\(/,
    run: (() => {
      // Combinatorics: factorial, nCr, nPr and the number of distinct arrangements of a word (exact, any size).
      const fact = (n) => {
        let r = 1n;
        for (let i = 2n; i <= n; i++) r *= i;
        return r;
      };

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        let m;
        if (
          (m =
            /arrangements?\s+of\s+(?:the\s+word\s+)?["']?([a-z]{2,20})["']?|permutations?\s+of\s+(?:the\s+word\s+)?["']?([a-z]{2,20})["']?/.exec(
              t,
            ))
        ) {
          const w = m[1] ?? m[2];
          const counts = {};
          for (const ch of w) counts[ch] = (counts[ch] ?? 0n) + 1n;
          let r = fact(BigInt(w.length));
          for (const c of Object.values(counts)) r /= fact(c);
          return {
            ok: true,
            word: w,
            arrangements: String(r),
            answer: `${w.toUpperCase()} can be arranged in ${r} distinct ways.`,
          };
        }
        if (
          (m =
            /(\d+)\s*(?:choose|c)\s*(\d+)|\bncr\s*\(?(\d+)[ ,]+(\d+)|\bc\((\d+)\s*,\s*(\d+)\)/.exec(
              t,
            ))
        ) {
          const n = BigInt(m[1] ?? m[3] ?? m[5]);
          const k = BigInt(m[2] ?? m[4] ?? m[6]);
          if (k > n || n > 5000n) return { ok: false, error: "Need k <= n and n <= 5000." };
          const r = fact(n) / (fact(k) * fact(n - k));
          return {
            ok: true,
            n: String(n),
            k: String(k),
            combinations: String(r),
            answer: `C(${n},${k}) = ${r}.`,
          };
        }
        if (
          (m =
            /(\d+)\s*p\s*(\d+)|\bnpr\s*\(?(\d+)[ ,]+(\d+)|\bp\((\d+)\s*,\s*(\d+)\)|permutations?\s+of\s+(\d+)\s+(?:taken|choose|items?)?\s*(\d+)/.exec(
              t,
            ))
        ) {
          const n = BigInt(m[1] ?? m[3] ?? m[5] ?? m[7]);
          const k = BigInt(m[2] ?? m[4] ?? m[6] ?? m[8]);
          if (k > n || n > 5000n) return { ok: false, error: "Need k <= n and n <= 5000." };
          const r = fact(n) / fact(n - k);
          return {
            ok: true,
            n: String(n),
            k: String(k),
            permutations: String(r),
            answer: `P(${n},${k}) = ${r}.`,
          };
        }
        if ((m = /(\d+)\s*!|factorial\s*(?:of)?\s*(\d+)/.exec(t))) {
          const n = BigInt(m[1] ?? m[2]);
          if (n > 3000n) return { ok: false, error: "Factorial up to 3000." };
          const r = String(fact(n));
          return {
            ok: true,
            n: String(n),
            factorial: r,
            answer: `${n}! = ${r.length > 80 ? r.slice(0, 40) + "... (" + r.length + " digits)" : r}`,
          };
        }
        return {
          ok: false,
          error: "Say it like 10 choose 3, 10P3, 5! or arrangements of MISSISSIPPI.",
        };
      }

      return run;
    })(),
  },
  {
    id: "equation",
    gate: /solve|equation|quadratic|roots?|x\^2|x2|\dx\b|x\s*=/,
    run: (() => {
      // Equations: linear, quadratic (real and complex roots) and a pair of linear equations.
      const clean = (s) =>
        s
          .toLowerCase()
          .replace(/\s+/g, "")
          .replace(/\*\*/g, "^")
          .replace(/\*/g, "")
          .replace(/−/g, "-");
      const r6 = (n) => Number(n.toPrecision(10));

      function poly(side) {
        const co = { 2: 0, 1: 0, 0: 0, y: 0 };
        const terms = side.replace(/-/g, "+-").split("+").filter(Boolean);
        for (const term of terms) {
          let m;
          if ((m = /^(-?\d*\.?\d*)x\^2$/.exec(term)) || (m = /^(-?\d*\.?\d*)x2$/.exec(term)))
            co[2] += m[1] === "" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
          else if ((m = /^(-?\d*\.?\d*)x$/.exec(term)))
            co[1] += m[1] === "" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
          else if ((m = /^(-?\d*\.?\d*)y$/.exec(term)))
            co.y += m[1] === "" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
          else if ((m = /^(-?\d+\.?\d*)$/.exec(term))) co[0] += Number(m[1]);
          else return null;
        }
        return co;
      }
      function sides(eq) {
        const [l, r = "0"] = clean(eq).split("=");
        const a = poly(l);
        const b = poly(r);
        if (!a || !b) return null;
        return { 2: a[2] - b[2], 1: a[1] - b[1], 0: a[0] - b[0], y: a.y - b.y };
      }

      async function run(input = {}) {
        const raw = String(input.equation ?? input?.prompt ?? input?.text ?? "");
        const text = raw
          .replace(/^[^0-9a-z-]*(?:solve|find|roots? of|the equation|equation)\b[:\s]*/i, "")
          .replace(/\bfor x\b|\bwhere\b|\?/gi, "");
        const eqs = text
          .split(/[;,]|\band\b/i)
          .map((s) => s.trim())
          .filter((s) => /=/.test(s) || /x/.test(s));
        if (eqs.length >= 2 && eqs.every((e) => /y/i.test(e) || /x/i.test(e))) {
          const a = sides(eqs[0]);
          const b = sides(eqs[1]);
          if (a && b && (a.y || b.y)) {
            const det = a[1] * b.y - b[1] * a.y;
            if (det === 0)
              return {
                ok: true,
                solution: null,
                answer: "The lines are parallel or the same: no single solution.",
              };
            const x = (-a[0] * b.y + b[0] * a.y) / det;
            const y = (-a[1] * b[0] + b[1] * a[0]) / det;
            return { ok: true, x: r6(x), y: r6(y), answer: `x = ${r6(x)}, y = ${r6(y)}.` };
          }
        }
        const e = sides(eqs[0] ?? text);
        if (!e)
          return {
            ok: false,
            error: "Write the equation like x^2 - 5x + 6 = 0, 2x + 3 = 11, or 2x+3y=12, x-y=1.",
          };
        const { 2: a, 1: b, 0: c } = e;
        if (!a && !b) return { ok: false, error: "No x found in the equation." };
        if (!a) return { ok: true, degree: 1, x: r6(-c / b), answer: `x = ${r6(-c / b)}.` };
        const d = b * b - 4 * a * c;
        if (d >= 0) {
          const x1 = (-b + Math.sqrt(d)) / (2 * a);
          const x2 = (-b - Math.sqrt(d)) / (2 * a);
          return {
            ok: true,
            degree: 2,
            discriminant: r6(d),
            roots: [r6(x1), r6(x2)],
            answer: `Discriminant ${r6(d)}; x = ${r6(x1)}${d === 0 ? " (double root)" : ` or x = ${r6(x2)}`}.`,
          };
        }
        const re = r6(-b / (2 * a));
        const im = r6(Math.sqrt(-d) / (2 * a));
        return {
          ok: true,
          degree: 2,
          discriminant: r6(d),
          roots: [`${re} + ${Math.abs(im)}i`, `${re} - ${Math.abs(im)}i`],
          answer: `No real roots (discriminant ${r6(d)}); x = ${re} +/- ${Math.abs(im)}i.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "geometry",
    gate: /area|volume|perimeter|circumference|hypotenuse|pythag|surface area|diagonal/,
    run: (() => {
      // Geometry: area, perimeter, volume and surface of common shapes, and the missing side of a right triangle.
      const r4 = (n) => Math.round(n * 10000) / 10000;
      const PI = Math.PI;

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const n = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
        const has = (re) => re.test(t);
        const one = (label) => ({ ok: false, error: `Give the ${label}.` });
        if (has(/hypotenuse|pythag|right.?(?:angle|angled)? triangle/)) {
          if (n.length < 2) return one("two sides");
          if (has(/other side|leg|missing/) && n.length >= 2) {
            const [h, s] = n[0] > n[1] ? [n[0], n[1]] : [n[1], n[0]];
            return {
              ok: true,
              side: r4(Math.sqrt(h * h - s * s)),
              answer: `The missing side is ${r4(Math.sqrt(h * h - s * s))}.`,
            };
          }
          const h = Math.hypot(n[0], n[1]);
          return {
            ok: true,
            hypotenuse: r4(h),
            answer: `Hypotenuse = sqrt(${n[0]}^2 + ${n[1]}^2) = ${r4(h)}.`,
          };
        }
        if (has(/circle|circumference|disc/)) {
          if (!n.length) return one("radius");
          const r = has(/diameter/) ? n[0] / 2 : n[0];
          return {
            ok: true,
            radius: r,
            area: r4(PI * r * r),
            circumference: r4(2 * PI * r),
            answer: `Radius ${r}: area ${r4(PI * r * r)}, circumference ${r4(2 * PI * r)}.`,
          };
        }
        if (has(/sphere|ball/)) {
          if (!n.length) return one("radius");
          const r = has(/diameter/) ? n[0] / 2 : n[0];
          return {
            ok: true,
            volume: r4((4 / 3) * PI * r ** 3),
            surfaceArea: r4(4 * PI * r * r),
            answer: `Sphere r=${r}: volume ${r4((4 / 3) * PI * r ** 3)}, surface area ${r4(4 * PI * r * r)}.`,
          };
        }
        if (has(/cylinder/)) {
          if (n.length < 2) return one("radius and height");
          const [r, h] = n;
          return {
            ok: true,
            volume: r4(PI * r * r * h),
            surfaceArea: r4(2 * PI * r * (r + h)),
            answer: `Cylinder r=${r}, h=${h}: volume ${r4(PI * r * r * h)}, surface area ${r4(2 * PI * r * (r + h))}.`,
          };
        }
        if (has(/\bcone\b/)) {
          if (n.length < 2) return one("radius and height");
          const [r, h] = n;
          const l = Math.hypot(r, h);
          return {
            ok: true,
            volume: r4((PI * r * r * h) / 3),
            surfaceArea: r4(PI * r * (r + l)),
            answer: `Cone r=${r}, h=${h}: volume ${r4((PI * r * r * h) / 3)}, surface area ${r4(PI * r * (r + l))}.`,
          };
        }
        if (has(/\bcube\b/)) {
          if (!n.length) return one("side");
          return {
            ok: true,
            volume: r4(n[0] ** 3),
            surfaceArea: r4(6 * n[0] ** 2),
            answer: `Cube side ${n[0]}: volume ${r4(n[0] ** 3)}, surface area ${r4(6 * n[0] ** 2)}.`,
          };
        }
        if (has(/cuboid|box|room volume/) && n.length >= 3) {
          const [l, w, h] = n;
          return {
            ok: true,
            volume: r4(l * w * h),
            surfaceArea: r4(2 * (l * w + w * h + l * h)),
            answer: `Cuboid ${l} x ${w} x ${h}: volume ${r4(l * w * h)}, surface area ${r4(2 * (l * w + w * h + l * h))}.`,
          };
        }
        if (has(/triangle/)) {
          if (n.length === 3 && !has(/base|height/)) {
            const [a, b, c] = n;
            const s = (a + b + c) / 2;
            const q = s * (s - a) * (s - b) * (s - c);
            if (q <= 0) return { ok: false, error: "These three sides cannot form a triangle." };
            return {
              ok: true,
              area: r4(Math.sqrt(q)),
              perimeter: a + b + c,
              answer: `Triangle ${a}, ${b}, ${c}: area ${r4(Math.sqrt(q))} (Heron), perimeter ${a + b + c}.`,
            };
          }
          if (n.length >= 2)
            return {
              ok: true,
              area: r4((n[0] * n[1]) / 2),
              answer: `Triangle base ${n[0]}, height ${n[1]}: area ${r4((n[0] * n[1]) / 2)}.`,
            };
          return one("base and height, or three sides");
        }
        if (has(/rectangle|square|plot|field|floor|wall|room/)) {
          if (!n.length) return one("length and width");
          const [l, w] = n.length >= 2 && !has(/\bsquare\b/) ? n : [n[0], n[0]];
          return {
            ok: true,
            area: r4(l * w),
            perimeter: r4(2 * (l + w)),
            diagonal: r4(Math.hypot(l, w)),
            answer: `${l} x ${w}: area ${r4(l * w)}, perimeter ${r4(2 * (l + w))}, diagonal ${r4(Math.hypot(l, w))}.`,
          };
        }
        return {
          ok: false,
          error:
            "Name a shape: circle, rectangle, triangle, sphere, cylinder, cone, cube, or a right triangle.",
        };
      }

      return run;
    })(),
  },
  {
    id: "fraction-ratio",
    gate: /fraction|simplify|ratio|proportion|\d\/\d/,
    run: (() => {
      // Fractions and ratios: simplify, add and multiply fractions, decimal to fraction, and split an amount by a ratio.
      const gcd = (a, b) => {
        a = Math.abs(a);
        b = Math.abs(b);
        while (b) [a, b] = [b, a % b];
        return a || 1;
      };
      const norm = (n, d) => {
        if (d < 0) [n, d] = [-n, -d];
        const g = gcd(n, d);
        return [n / g, d / g];
      };
      const show = ([n, d]) => (d === 1 ? String(n) : `${n}/${d}`);

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/×/g, "*")
          .replace(/÷/g, "/");
        let m;
        if (
          (m =
            /(\d+(?:\.\d+)?)\s*(?:in|into|among|between|ratio)\s*(?:the\s*)?(?:ratio\s*)?((?:\d+\s*:\s*)+\d+)/.exec(
              t,
            )) ||
          (m = /(?:split|divide|share)\s+(\d+(?:\.\d+)?).*?((?:\d+\s*:\s*)+\d+)/.exec(t))
        ) {
          const total = Number(m[1]);
          const parts = m[2].split(":").map((x) => Number(x.trim()));
          const sum = parts.reduce((a, b) => a + b, 0);
          if (!(sum > 0)) return { ok: false, error: "The ratio parts must add to more than 0." };
          const shares = parts.map((p) => Math.round(((total * p) / sum) * 100) / 100);
          return {
            ok: true,
            shares,
            answer: `${total} split ${parts.join(":")} = ${shares.join(", ")}.`,
          };
        }
        if ((m = /(\d+)\s*\/\s*(\d+)\s*([-+*/])\s*(\d+)\s*\/\s*(\d+)/.exec(t.replace(/\s/g, "")))) {
          const [a, b, , c, d] = [m[1], m[2], m[3], m[4], m[5]].map((x, i) =>
            i === 2 ? x : Number(x),
          );
          const op = m[3];
          if (b === 0 || d === 0) return { ok: false, error: "A denominator cannot be zero." };
          let r;
          if (op === "+") r = norm(a * d + c * b, b * d);
          else if (op === "-") r = norm(a * d - c * b, b * d);
          else if (op === "*") r = norm(a * c, b * d);
          else {
            if (c === 0) return { ok: false, error: "Cannot divide by zero." };
            r = norm(a * d, b * c);
          }
          return {
            ok: true,
            result: show(r),
            decimal: Math.round((r[0] / r[1]) * 1e6) / 1e6,
            answer: `${a}/${b} ${op} ${c}/${d} = ${show(r)} (${Math.round((r[0] / r[1]) * 1e6) / 1e6}).`,
          };
        }
        if ((m = /(\d+)\s*\/\s*(\d+)/.exec(t)) && /simplif|reduce|lowest/.test(t)) {
          if (Number(m[2]) === 0) return { ok: false, error: "A denominator cannot be zero." };
          const r = norm(Number(m[1]), Number(m[2]));
          return { ok: true, result: show(r), answer: `${m[1]}/${m[2]} = ${show(r)}.` };
        }
        if ((m = /(\d*\.\d+)/.exec(t)) && /fraction/.test(t)) {
          const x = Number(m[1]);
          let best = [Math.round(x), 1];
          for (let d = 1; d <= 10000; d++) {
            const n = Math.round(x * d);
            if (Math.abs(n / d - x) < 1e-9) {
              best = [n, d];
              break;
            }
          }
          const r = norm(best[0], best[1]);
          return { ok: true, result: show(r), answer: `${x} = ${show(r)}.` };
        }
        return {
          ok: false,
          error:
            "Say it like simplify 18/24, 2/3 + 3/4, 0.375 as a fraction, or split 100 in ratio 2:3:5.",
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
