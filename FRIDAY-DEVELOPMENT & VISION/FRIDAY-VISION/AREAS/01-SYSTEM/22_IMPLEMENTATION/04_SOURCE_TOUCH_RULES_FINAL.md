# Source Touch Rules — Final

Before changing a file:
1. identify the current owner;
2. find existing call sites and registry paths;
3. determine whether a contract already exists;
4. make the smallest compatible change;
5. reuse current IPC, database and service boundaries;
6. avoid duplicate helper modules;
7. update only the relevant docs;
8. run the minimum targeted tests and required regression/build checks.

Protected unless absolutely required: installer, packaging, release scripts, CI/CD, updater and build configuration.
