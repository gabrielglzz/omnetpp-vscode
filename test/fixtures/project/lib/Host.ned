package lib;

simple Radio
{
    parameters:
        // Parentheses inside the strings of a property
        string opMode @enum("a", "g(erp)", "g(mixed)") = default("g(erp)");
        string bandName @enum("2.4 GHz", "5 GHz (20 MHz)") = default("2.4 GHz");
}

simple Queue
{
    parameters:
        int capacity = default(5);
}

// Created at run time from C++, never declared as a submodule
simple Profile
{
    parameters:
        bool autoOutputFileNames = default(false);
}

module Host
{
    parameters:
        int numApps = default(0);
    submodules:
        app[numApps]: <> like IApp;
        gptp: <> like IApp;
        radio: Radio;
        queue: Queue {
            capacity = 10;
        }
}
