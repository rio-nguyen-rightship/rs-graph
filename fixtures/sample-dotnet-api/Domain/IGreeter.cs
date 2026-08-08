namespace SampleApi.Domain;

/// <summary>Greets a named visitor.</summary>
public interface IGreeter
{
    /// <summary>Builds a greeting for the given name.</summary>
    string Greet(string name);
}
