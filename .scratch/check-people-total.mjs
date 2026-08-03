import { getPeople } from "./lib/data/people.ts";
const r = await getPeople({}, 1, 1);
console.log("unfiltered people total:", r.total);
