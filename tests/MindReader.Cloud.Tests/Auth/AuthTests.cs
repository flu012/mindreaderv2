using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace MindReader.Cloud.Tests.Auth;

public class AuthTests : IClassFixture<CustomWebApplicationFactory>
{
    private readonly HttpClient _client;

    public AuthTests(CustomWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Register_ValidCredentials_ReturnsTokenAndUser()
    {
        var response = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "test@example.com",
            Password = "TestPass123!",
            Name = "Test User"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.TryGetProperty("token", out var token));
        Assert.False(string.IsNullOrEmpty(token.GetString()));
        Assert.True(json.TryGetProperty("refreshToken", out var refresh));
        Assert.False(string.IsNullOrEmpty(refresh.GetString()));
        Assert.True(json.TryGetProperty("user", out var user));
        Assert.Equal("test@example.com", user.GetProperty("email").GetString());
        Assert.Equal("Test User", user.GetProperty("name").GetString());
        Assert.False(string.IsNullOrEmpty(user.GetProperty("tenantId").GetString()));
    }

    [Fact]
    public async Task Register_DuplicateEmail_ReturnsBadRequest()
    {
        await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "dupe@example.com",
            Password = "TestPass123!",
            Name = "User 1"
        });

        var response = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "dupe@example.com",
            Password = "TestPass123!",
            Name = "User 2"
        });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Login_ValidCredentials_ReturnsToken()
    {
        // Register first
        await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "login@example.com",
            Password = "TestPass123!",
            Name = "Login User"
        });

        // Login
        var response = await _client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            Email = "login@example.com",
            Password = "TestPass123!"
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.TryGetProperty("token", out var token));
        Assert.False(string.IsNullOrEmpty(token.GetString()));
    }

    [Fact]
    public async Task Login_InvalidPassword_ReturnsUnauthorized()
    {
        await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "badpass@example.com",
            Password = "TestPass123!",
            Name = "Bad Pass User"
        });

        var response = await _client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            Email = "badpass@example.com",
            Password = "WrongPassword!"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Login_NonexistentUser_ReturnsUnauthorized()
    {
        var response = await _client.PostAsJsonAsync("/api/v1/auth/login", new
        {
            Email = "nobody@example.com",
            Password = "TestPass123!"
        });

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Me_WithToken_ReturnsUserInfo()
    {
        // Register to get token
        var regResponse = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "me@example.com",
            Password = "TestPass123!",
            Name = "Me User"
        });
        var regJson = await regResponse.Content.ReadFromJsonAsync<JsonElement>();
        var token = regJson.GetProperty("token").GetString()!;

        // Call /me with token
        var request = new HttpRequestMessage(HttpMethod.Get, "/api/v1/auth/me");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        var response = await _client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(json.GetProperty("userId").GetInt32() > 0);
        Assert.False(string.IsNullOrEmpty(json.GetProperty("tenantId").GetString()));
    }

    [Fact]
    public async Task Me_WithoutToken_ReturnsUnauthorized()
    {
        var response = await _client.GetAsync("/api/v1/auth/me");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task RefreshToken_Valid_ReturnsNewToken()
    {
        // Register to get tokens
        var regResponse = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "refresh@example.com",
            Password = "TestPass123!",
            Name = "Refresh User"
        });
        var regJson = await regResponse.Content.ReadFromJsonAsync<JsonElement>();
        var refreshToken = regJson.GetProperty("refreshToken").GetString()!;

        // Refresh
        var response = await _client.PostAsJsonAsync("/api/v1/auth/refresh", new
        {
            RefreshToken = refreshToken
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrEmpty(json.GetProperty("token").GetString()));
    }

    [Fact]
    public async Task Register_CreatesTenantWithUniqueId()
    {
        // Register two users
        var reg1 = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "tenant1@example.com", Password = "TestPass123!", Name = "User 1"
        });
        var reg2 = await _client.PostAsJsonAsync("/api/v1/auth/register", new
        {
            Email = "tenant2@example.com", Password = "TestPass123!", Name = "User 2"
        });

        var json1 = await reg1.Content.ReadFromJsonAsync<JsonElement>();
        var json2 = await reg2.Content.ReadFromJsonAsync<JsonElement>();

        var tenantId1 = json1.GetProperty("user").GetProperty("tenantId").GetString();
        var tenantId2 = json2.GetProperty("user").GetProperty("tenantId").GetString();

        Assert.NotEqual(tenantId1, tenantId2);
        Assert.False(string.IsNullOrEmpty(tenantId1));
        Assert.False(string.IsNullOrEmpty(tenantId2));
    }
}
