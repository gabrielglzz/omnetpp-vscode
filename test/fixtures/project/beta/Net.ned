package beta;

import lib.Host;

network Net
{
    types:
        // Nested type: its submodules are not those of Net
        module Area
        {
            parameters:
                int numAreas = default(1);
            submodules:
                inner: Host;
        }
    submodules:
        area: Area;
        host: Host;
}

network Other
{
    submodules:
        srv: Host;
}
