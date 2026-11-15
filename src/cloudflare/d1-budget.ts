/** Conservative logical SQL statement budget shared by every D1 call in an invocation.
 * Local workerd does not enforce the hosted Free-plan quota. Counting each batch
 * statement also bounds work when the transport groups multiple statements. */
export class D1QueryBudgetExceeded extends Error {
	constructor() {
		super("D1 invocation query budget exhausted; retry in a new invocation");
	}
}

export class D1QueryBudget {
	used = 0;
	constructor(readonly limit = 50) {}
	get remaining() {
		return this.limit - this.used;
	}
	private charge(count: number) {
		if (count > this.remaining) throw new D1QueryBudgetExceeded();
		this.used += count;
	}
	wrap(database: D1Database): D1Database {
		const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
		const statement = (raw: D1PreparedStatement): D1PreparedStatement => {
			const wrapped = new Proxy(raw, {
				get: (target, key) => {
					if (key === "bind")
						return (...values: unknown[]) => statement(target.bind(...values));
					const value = Reflect.get(target, key, target);
					if (["all", "first", "raw", "run"].includes(String(key)))
						return (...args: unknown[]) => {
							this.charge(1);
							return Reflect.apply(value, target, args);
						};
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			originals.set(wrapped, raw);
			return wrapped;
		};
		return new Proxy(database, {
			get: (target, key) => {
				if (key === "prepare")
					return (query: string) => statement(target.prepare(query));
				if (key === "batch")
					return (statements: D1PreparedStatement[]) => {
						this.charge(statements.length);
						return target.batch(statements.map((s) => originals.get(s) ?? s));
					};
				// Application code uses prepared SQL only: multi-statement exec cannot
				// be accurately budgeted without a SQL parser, so refuse it here.
				if (key === "exec")
					return () => {
						throw new Error("Use prepared statements with the D1 query budget");
					};
				if (key === "withSession")
					return () => {
						throw new Error("D1 sessions are not used by this ledger");
					};
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}
