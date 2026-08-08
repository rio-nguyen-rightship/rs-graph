namespace SampleApi.Domain;

// Second half of the partial Greeter class — regression coverage for a real bug: a partial
// class/struct spanning multiple files must not be emitted twice just because Roslyn's
// semantic model visits it once per declaring file (see SymbolGraphBuilder's
// _emittedSymbolIds / TryClaim).
public partial class Greeter
{
    public string Describe()
    {
        return $"Greeter[{GetType().Name}]";
    }
}
