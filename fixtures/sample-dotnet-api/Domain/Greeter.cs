namespace SampleApi.Domain;

public partial class Greeter : IGreeter
{
    public string Greet(string name)
    {
        return BuildMessage(name);
    }

    private string BuildMessage(string name)
    {
        return $"Hello, {name}!";
    }
}
