package alpha;

import lib.Host;

// Same simple names as beta.Net and beta.Net.Area, in a folder that is indexed first
network Net
{
    submodules:
        other: Host;
}

module Area
{
    parameters:
        int unrelated = default(0);
}
