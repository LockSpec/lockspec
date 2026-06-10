import { InMemoryStore } from "../helpers/in-memory-store.js";
import { describeStoreContract } from "./store-contract.js";

// The in-memory fake must satisfy the full Store contract. The same
// describeStoreContract suite re-runs against the real LocalStore.
describeStoreContract("InMemoryStore", () => new InMemoryStore());
