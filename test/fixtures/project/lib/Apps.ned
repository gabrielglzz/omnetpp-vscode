package lib;

moduleinterface IApp
{
}

// Implementations of IGptp also fit the `like IApp` submodules
moduleinterface IGptp extends IApp
{
}

module MultiDomainGptp like IGptp
{
    parameters:
        int numDomains;
}

simple UdpApp like IApp
{
    parameters:
        int localPort = default(0);
}
